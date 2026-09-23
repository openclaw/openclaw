import "../../test/dom.setup.ts";
import { render as litRender } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { renderCardMeta } from "./view-card-content.ts";

function rect(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height: 24,
    top: 0,
    right: width,
    bottom: 24,
    left: 0,
    toJSON: () => ({}),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("recalculates label overflow without observing the chips it hides", async () => {
  const observed: Element[] = [];
  let deliverResize: ResizeObserverCallback | undefined;
  class RecordingResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      deliverResize = callback;
    }

    observe(target: Element) {
      observed.push(target);
    }

    unobserve() {}

    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RecordingResizeObserver);

  const card: WorkboardCard = {
    id: "label-overflow",
    title: "Keep label overflow accessible",
    status: "todo",
    priority: "normal",
    labels: ["first label", "second label"],
    position: 1_000,
    createdAt: 1,
    updatedAt: 1,
  };
  const container = document.createElement("div");
  document.body.append(container);
  litRender(renderCardMeta(card, false), container);

  const labels = container.querySelector<HTMLElement>(".workboard-card__labels");
  const chips = [...container.querySelectorAll<HTMLElement>(".workboard-card__label")];
  const overflow = container.querySelector<HTMLElement>(".workboard-card__label-overflow");
  if (!labels || !overflow) {
    throw new Error("Workboard card labels did not render");
  }
  expect(chips).toHaveLength(2);

  let availableWidth = 70;
  Object.defineProperty(labels, "clientWidth", {
    configurable: true,
    get: () => availableWidth,
  });
  const chipRectReads = chips.map(() => vi.fn(() => rect(40)));
  for (const [index, chip] of chips.entries()) {
    Object.defineProperty(chip, "getBoundingClientRect", {
      configurable: true,
      value: chipRectReads[index],
    });
  }
  const overflowRectRead = vi.fn(() => rect(24));
  Object.defineProperty(overflow, "getBoundingClientRect", {
    configurable: true,
    value: overflowRectRead,
  });

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

  expect(observed).toEqual([labels]);
  expect(chips.map((chip) => chip.hidden)).toEqual([false, true]);
  expect(overflow.hidden).toBe(false);
  expect(overflow.textContent).toBe("+1");
  expect(overflow.title).toBe("second label");
  expect(overflow.getAttribute("aria-label")).toContain("second label");
  expect(chipRectReads.map((read) => read.mock.calls.length)).toEqual([1, 1]);
  expect(overflowRectRead).toHaveBeenCalledTimes(1);

  const stableMutations: MutationRecord[] = [];
  const mutationObserver = new MutationObserver((records) => stableMutations.push(...records));
  mutationObserver.observe(labels, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  deliverResize?.(
    [{ target: labels, contentRect: rect(70) } as unknown as ResizeObserverEntry],
    {} as ResizeObserver,
  );
  await Promise.resolve();
  expect(stableMutations).toEqual([]);
  expect(chipRectReads.map((read) => read.mock.calls.length)).toEqual([1, 1]);
  expect(overflowRectRead).toHaveBeenCalledTimes(1);
  mutationObserver.disconnect();

  availableWidth = 40;
  deliverResize?.(
    [{ target: labels, contentRect: rect(40) } as unknown as ResizeObserverEntry],
    {} as ResizeObserver,
  );
  expect(chips.map((chip) => chip.hidden)).toEqual([true, true]);
  expect(overflow.textContent).toBe("+2");
  expect(overflow.title).toBe("first label, second label");
});
