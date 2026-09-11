import "../test/host.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { html, render, type LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { renderWorkboardToast } from "./toast.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it.each([false, true])(
  "preserves a hidden toast's visible lifetime, initially hidden: %s",
  async (initiallyHidden) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const container = document.createElement("div");
    document.body.append(container);
    const update = async (hidden: boolean) => {
      render(
        renderWorkboardToast({ message: "Session unavailable", tone: "error", hidden }),
        container,
      );
      const toast = expectDefined(
        container.querySelector<LitElement>("openclaw-workboard-toast"),
        "toast",
      );
      await toast.updateComplete;
      return toast;
    };

    await update(initiallyHidden);
    if (!initiallyHidden) {
      await vi.advanceTimersByTimeAsync(4_000);
      await update(true);
    }
    await vi.advanceTimersByTimeAsync(12_000);
    let toast = await update(false);
    expect(toast.shadowRoot?.querySelector('[role="alert"]')?.textContent).toBe(
      "Session unavailable",
    );

    await vi.advanceTimersByTimeAsync((initiallyHidden ? 10_000 : 6_000) - 1);
    await toast.updateComplete;
    expect(toast.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await toast.updateComplete;
    expect(toast.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
    toast = await update(false);
    expect(toast.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
  },
);

it.each(
  (["dismiss", "expire"] as const).flatMap((action) =>
    (["empty dialog", "transient error"] as const).map((interruption) => ({
      action,
      interruption,
    })),
  ),
)(
  "does not resurrect a board result after $action and an $interruption",
  async ({ action, interruption }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const container = document.createElement("div");
    document.body.append(container);
    const owner = {};
    let result = { completed: 2, total: 2 };
    let error = "";
    const update = async (dialogOpen: boolean) => {
      render(
        html`${renderWorkboardToast({
          owner,
          outcomeSource: true,
          message: error || "Applied to 2 of 2 cards.",
          key: error || result,
          tone: error ? "error" : "info",
          hidden: dialogOpen,
        })}${renderWorkboardToast({ owner, message: "", hidden: !dialogOpen })}`,
        container,
      );
      const elements = [...container.querySelectorAll<LitElement>("openclaw-workboard-toast")];
      await Promise.all(elements.map((element) => element.updateComplete));
      return expectDefined(elements[0], "board toast");
    };
    const boardToast = await update(false);
    expect(boardToast.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe(
      "Applied to 2 of 2 cards.",
    );
    if (action === "dismiss") {
      expectDefined(
        boardToast.shadowRoot?.querySelector<HTMLButtonElement>("button"),
        "close",
      ).click();
    } else {
      await vi.advanceTimersByTimeAsync(6_000);
    }
    await boardToast.updateComplete;
    expect(boardToast.shadowRoot?.querySelector('[role="status"]')).toBeNull();
    if (interruption === "empty dialog") {
      await update(true);
      await vi.advanceTimersByTimeAsync(12_000);
      await update(false);
    } else {
      error = "Session unavailable";
      await update(false);
      expect(boardToast.shadowRoot?.querySelector('[role="alert"]')?.textContent).toBe(error);
      await vi.advanceTimersByTimeAsync(10_000);
      await boardToast.updateComplete;
      expect(boardToast.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
      error = "";
      await update(false);
      expect(boardToast.shadowRoot?.querySelector('[role="status"]')).toBeNull();
      error = "Session unavailable";
      await update(false);
      expect(boardToast.shadowRoot?.querySelector('[role="alert"]')?.textContent).toBe(error);
      error = "";
      await update(false);
    }
    expect(boardToast.shadowRoot?.querySelector('[role="status"]')).toBeNull();
    result = { completed: 2, total: 2 };
    await update(false);
    expect(boardToast.shadowRoot?.querySelector('[role="status"]')).not.toBeNull();
  },
);
