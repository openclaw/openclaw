import "../test/host.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "@solidjs/web";
import { createComponent, createSignal, flush, merge } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { WorkboardToast } from "./toast.tsx";

const errorMessage = "Session unavailable";
let disposeRoot: (() => void) | undefined;

afterEach(() => {
  disposeRoot?.();
  disposeRoot = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mountToasts(...sources: (() => Parameters<typeof WorkboardToast>[0])[]) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const container = document.body.appendChild(document.createElement("div"));
  const toasts = () => sources.map((source) => createComponent(WorkboardToast, merge(source)));
  disposeRoot = render(toasts, container);
  flush();
  return expectDefined(container.querySelector("openclaw-workboard-toast"), "toast");
}

function createFlushedSignal<T>(initial: T) {
  const [read, write] = createSignal<T>(() => initial);
  const update = (value: T) => {
    write(() => value);
    flush();
  };
  return [read, update] as const;
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

it.each([false, true])("pauses lifetime while hidden: %s", async (initiallyHidden) => {
  const [hidden, update] = createFlushedSignal(initiallyHidden);
  const toast = mountToasts(() => ({ message: errorMessage, tone: "error", hidden: hidden() }));
  if (!initiallyHidden) {
    await vi.advanceTimersByTimeAsync(4_000);
    update(true);
  }
  await vi.advanceTimersByTimeAsync(12_000);
  update(false);
  expect(toast.querySelector('[role="alert"]')?.textContent).toBe(errorMessage);
  await advance((initiallyHidden ? 10_000 : 6_000) - 1);
  expect(toast.querySelector('[role="alert"]')).not.toBeNull();
  await advance(1);
  expect(toast.querySelector('[role="alert"]')).toBeNull();
  update(false);
  expect(toast.querySelector('[role="alert"]')).toBeNull();
});

it.each(["dismiss", "expire"])("keeps %s results dismissed", async (action) => {
  const owner = {};
  const [result, setResult] = createFlushedSignal({});
  const [error, setError] = createFlushedSignal("");
  const [dialogOpen, setDialogOpen] = createFlushedSignal(false);
  const boardToast = mountToasts(
    () => ({
      owner,
      outcomeSource: true,
      message: error() || "Applied to 2 of 2 cards.",
      key: error() || result(),
      tone: error() ? "error" : "info",
      hidden: dialogOpen(),
    }),
    () => ({ owner, message: "", hidden: !dialogOpen() }),
  );
  expect(boardToast.querySelector('[role="status"]')?.textContent).toBe("Applied to 2 of 2 cards.");
  if (action === "dismiss") {
    expectDefined(boardToast.querySelector<HTMLButtonElement>("button"), "close").click();
  } else {
    await vi.advanceTimersByTimeAsync(6_000);
  }
  flush();
  expect(boardToast.querySelector('[role="status"]')).toBeNull();
  if (action === "dismiss") {
    setDialogOpen(true);
    await vi.advanceTimersByTimeAsync(12_000);
    setDialogOpen(false);
  } else {
    setError(errorMessage);
    expect(boardToast.querySelector('[role="alert"]')?.textContent).toBe(errorMessage);
    await advance(10_000);
    expect(boardToast.querySelector('[role="alert"]')).toBeNull();
    setError("");
    expect(boardToast.querySelector('[role="status"]')).toBeNull();
    setError(errorMessage);
    expect(boardToast.querySelector('[role="alert"]')?.textContent).toBe(errorMessage);
    setError("");
  }
  expect(boardToast.querySelector('[role="status"]')).toBeNull();
  setResult({});
  expect(boardToast.querySelector('[role="status"]')).not.toBeNull();
});
