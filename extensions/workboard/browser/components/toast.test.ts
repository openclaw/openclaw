import "../test/host.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "@solidjs/web";
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkboardToast } from "./toast.tsx";

let container: HTMLDivElement;
let disposeRoot: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  disposeRoot?.();
  disposeRoot = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mountToasts(...props: Parameters<typeof WorkboardToast>[0][]) {
  disposeRoot = render(() => props.map((p) => createComponent(WorkboardToast, p)), container);
  flush();
  return expectDefined(container.querySelector("openclaw-workboard-toast"), "toast");
}

function createFlushedSignal<T>(initial: T) {
  const [read, write] = createSignal(initial);
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

it.each([false, true])(
  "preserves a hidden toast's visible lifetime, initially hidden: %s",
  async (initiallyHidden) => {
    const [hidden, update] = createFlushedSignal(initiallyHidden);
    const toast = mountToasts({
      message: "Session unavailable",
      tone: "error",
      get hidden() {
        return hidden();
      },
    });
    if (!initiallyHidden) {
      await vi.advanceTimersByTimeAsync(4_000);
      update(true);
    }
    await vi.advanceTimersByTimeAsync(12_000);
    update(false);
    expect(toast.querySelector('[role="alert"]')?.textContent).toBe("Session unavailable");
    await advance((initiallyHidden ? 10_000 : 6_000) - 1);
    expect(toast.querySelector('[role="alert"]')).not.toBeNull();
    await advance(1);
    expect(toast.querySelector('[role="alert"]')).toBeNull();
    update(false);
    expect(toast.querySelector('[role="alert"]')).toBeNull();
  },
);

it.each(["dismiss", "expire"])(
  "does not resurrect a board result after %s and a subsequent interruption",
  async (action) => {
    const owner = {};
    const [result, setResult] = createFlushedSignal({ completed: 2, total: 2 });
    const [error, setError] = createFlushedSignal("");
    const [dialogOpen, setDialogOpen] = createFlushedSignal(false);
    const boardToast = mountToasts(
      {
        owner,
        outcomeSource: true,
        get message() {
          return error() || "Applied to 2 of 2 cards.";
        },
        get key() {
          return error() || result();
        },
        get tone() {
          return error() ? "error" : "info";
        },
        get hidden() {
          return dialogOpen();
        },
      },
      {
        owner,
        message: "",
        get hidden() {
          return !dialogOpen();
        },
      },
    );
    expect(boardToast.querySelector('[role="status"]')?.textContent).toBe(
      "Applied to 2 of 2 cards.",
    );
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
      setError("Session unavailable");
      expect(boardToast.querySelector('[role="alert"]')?.textContent).toBe("Session unavailable");
      await advance(10_000);
      expect(boardToast.querySelector('[role="alert"]')).toBeNull();
      setError("");
      expect(boardToast.querySelector('[role="status"]')).toBeNull();
      setError("Session unavailable");
      expect(boardToast.querySelector('[role="alert"]')?.textContent).toBe("Session unavailable");
      setError("");
    }
    expect(boardToast.querySelector('[role="status"]')).toBeNull();
    setResult({ completed: 2, total: 2 });
    expect(boardToast.querySelector('[role="status"]')).not.toBeNull();
  },
);
