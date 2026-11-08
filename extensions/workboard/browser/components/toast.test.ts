import "../test/host.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "@solidjs/web";
import { createComponent, createSignal, flush, merge } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { WorkboardToast } from "./toast.tsx";

const errorMessage = "Session unavailable";
type ToastProps = Parameters<typeof WorkboardToast>[0];
let disposeRoot: (() => void) | undefined;

afterEach(() => {
  disposeRoot?.();
  disposeRoot = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mount(initial: ToastProps, shared = false) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const owner = shared ? {} : undefined;
  const [props, setProps] = createSignal(() => initial);
  const container = document.body.appendChild(document.createElement("div"));
  const view = (source: () => ToastProps) => createComponent(WorkboardToast, merge(source));
  const views = () => [
    view(() => ({ ...props(), owner, outcomeSource: shared })),
    shared && view(() => ({ owner, message: "", hidden: !props().hidden })),
  ];
  disposeRoot = render(views, container);
  flush();
  async function step(change: Partial<ToastProps>, elapsed = 0) {
    await vi.advanceTimersByTimeAsync(elapsed);
    setProps((previous) => ({ ...previous, ...change }));
    flush();
  }
  const toast = expectDefined(container.querySelector("openclaw-workboard-toast"), "toast");
  return { toast, step };
}

it.each([0, 4_000])("pauses lifetime while hidden after %d ms", async (elapsed) => {
  const { toast, step } = mount({ message: errorMessage, tone: "error", hidden: elapsed === 0 });
  await step({ hidden: true }, elapsed);
  await step({ hidden: false }, 12_000);
  expect(toast.querySelector('[role="alert"]')?.textContent).toBe(errorMessage);
  await step({}, 10_000 - elapsed - 1);
  expect(toast.querySelector('[role="alert"]')).not.toBeNull();
  await step({}, 1);
  expect(toast.querySelector('[role="alert"]')).toBeNull();
});

it.each(["dismiss", "expire"])("keeps %s results dismissed", async (action) => {
  const result: ToastProps = { message: "Applied to 2 of 2 cards.", key: {}, tone: "info" };
  const error: ToastProps = { message: errorMessage, key: errorMessage, tone: "error" };
  const { toast, step } = mount(result, true);
  expect(toast.querySelector('[role="status"]')?.textContent).toBe(result.message);
  if (action === "dismiss") {
    expectDefined(toast.querySelector<HTMLButtonElement>("button"), "close").click();
  } else {
    await step({}, 6_000);
  }
  flush();
  expect(toast.querySelector('[role="status"]')).toBeNull();
  if (action === "dismiss") {
    await step({ hidden: true });
    await step({ hidden: false }, 12_000);
  } else {
    await step(error);
    expect(toast.querySelector('[role="alert"]')?.textContent).toBe(errorMessage);
    await step({}, 10_000);
    expect(toast.querySelector('[role="alert"]')).toBeNull();
    await step(result);
    expect(toast.querySelector('[role="status"]')).toBeNull();
    await step(error);
    expect(toast.querySelector('[role="alert"]')?.textContent).toBe(errorMessage);
    await step(result);
  }
  expect(toast.querySelector('[role="status"]')).toBeNull();
  await step({ key: {} });
  expect(toast.querySelector('[role="status"]')).not.toBeNull();
});
