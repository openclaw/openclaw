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

it.each([false, true])(
  "preserves a hidden toast's visible lifetime, initially hidden: %s",
  async (initiallyHidden) => {
    const [hidden, setHidden] = createSignal(initiallyHidden);
    disposeRoot = render(
      () =>
        createComponent(WorkboardToast, {
          message: "Session unavailable",
          tone: "error",
          get hidden() {
            return hidden();
          },
        }),
      container,
    );
    const update = (value: boolean) => {
      setHidden(value);
      flush();
    };
    flush();
    const toast = expectDefined(container.querySelector("openclaw-workboard-toast"), "toast");
    if (!initiallyHidden) {
      await vi.advanceTimersByTimeAsync(4_000);
      update(true);
    }
    await vi.advanceTimersByTimeAsync(12_000);
    update(false);
    expect(toast.querySelector('[role="alert"]')?.textContent).toBe("Session unavailable");
    await vi.advanceTimersByTimeAsync((initiallyHidden ? 10_000 : 6_000) - 1);
    flush();
    expect(toast.querySelector('[role="alert"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    flush();
    expect(toast.querySelector('[role="alert"]')).toBeNull();
    update(false);
    expect(toast.querySelector('[role="alert"]')).toBeNull();
  },
);

it.each([
  { action: "dismiss", interruption: "empty dialog" },
  { action: "expire", interruption: "transient error" },
])(
  "does not resurrect a board result after $action and a subsequent $interruption",
  async ({ action, interruption }) => {
    const owner = {};
    const [result, setResult] = createSignal({ completed: 2, total: 2 });
    const [error, setError] = createSignal("");
    const [dialogOpen, setDialogOpen] = createSignal(false);
    disposeRoot = render(
      () => [
        createComponent(WorkboardToast, {
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
        }),
        createComponent(WorkboardToast, {
          owner,
          message: "",
          get hidden() {
            return !dialogOpen();
          },
        }),
      ],
      container,
    );
    flush();
    const boardToast = expectDefined(container.querySelector("openclaw-workboard-toast"), "toast");
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
    if (interruption === "empty dialog") {
      setDialogOpen(true);
      flush();
      await vi.advanceTimersByTimeAsync(12_000);
      setDialogOpen(false);
      flush();
    } else {
      setError("Session unavailable");
      flush();
      expect(boardToast.querySelector('[role="alert"]')?.textContent).toBe("Session unavailable");
      await vi.advanceTimersByTimeAsync(10_000);
      flush();
      expect(boardToast.querySelector('[role="alert"]')).toBeNull();
      setError("");
      flush();
      expect(boardToast.querySelector('[role="status"]')).toBeNull();
      setError("Session unavailable");
      flush();
      expect(boardToast.querySelector('[role="alert"]')?.textContent).toBe("Session unavailable");
      setError("");
      flush();
    }
    expect(boardToast.querySelector('[role="status"]')).toBeNull();
    setResult({ completed: 2, total: 2 });
    flush();
    expect(boardToast.querySelector('[role="status"]')).not.toBeNull();
  },
);
