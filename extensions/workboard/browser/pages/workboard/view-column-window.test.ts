import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createWorkboardView, openCardMenu, requireButton } from "./view.test-support.ts";

const frames = new Map<number, FrameRequestCallback>();
const observers = new Map<Element, Set<TestResizeObserver>>();
let nextFrame = 0;
class TestResizeObserver implements ResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const owners = observers.get(target) ?? new Set<TestResizeObserver>();
    owners.add(this);
    observers.set(target, owners);
  }
  unobserve(target: Element) {
    observers.get(target)?.delete(this);
  }
  disconnect() {
    for (const [target, owners] of observers) {
      owners.delete(this);
      if (!owners.size) {
        observers.delete(target);
      }
    }
  }
  deliver(target: Element, height: number) {
    const size = { blockSize: height, inlineSize: 320 };
    this.callback(
      [
        {
          target,
          borderBoxSize: [size],
          contentBoxSize: [size],
          devicePixelContentBoxSize: [size],
          contentRect: new DOMRect(0, 0, 320, height),
        },
      ],
      this,
    );
  }
}
beforeEach(() => {
  frames.clear();
  observers.clear();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

async function settleFrames(afterFrame?: () => void) {
  let count = 0;
  for (; count < 8; count++) {
    await Promise.resolve();
    flush();
    if (!frames.size) {
      return count;
    }
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
    flush();
    afterFrame?.();
  }
  expect(frames.size, "layout work must settle without observing its own style writes").toBe(0);
  return count;
}

describe("Workboard column window", () => {
  it("bounds a large board while retaining menu and focus anchors and logical drop order", () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.viewMode = "board";
    state.cards = Array.from({ length: 60 }, (_, index) =>
      createWorkboardCard({ id: `card-${index}`, position: (index + 1) * 1000 }),
    );
    renderView();
    const column = expectDefined(
      container.querySelector<HTMLElement>(".workboard-column--todo"),
      "todo column",
    );
    const viewport = expectDefined(
      column.querySelector<HTMLElement>(".workboard-column__cards"),
      "column viewport",
    );
    const row = (id: string) =>
      column.querySelector<HTMLElement>(`.workboard-column__item[data-card-id="${id}"]`);
    expect(column.querySelectorAll(".workboard-card").length).toBeLessThan(20);
    expect(row("card-20")).toBeNull();

    const menuRow = expectDefined(row("card-2"), "menu row");
    openCardMenu(menuRow);
    viewport.scrollTop = 5000;
    viewport.dispatchEvent(new Event("scroll"));
    renderView();
    expect(row("card-2")).toBe(menuRow);
    const focusRow = expectDefined(row("card-28"), "scrolled row");
    const focusCard = expectDefined(focusRow.querySelector<HTMLElement>("article"), "card");
    focusCard.focus();
    expect(document.activeElement === focusCard, "card starts focused").toBe(true);
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    renderView();
    expect(row("card-28")).toBe(focusRow);
    expect(focusRow.querySelector("article")).toBe(focusCard);
    expect(document.activeElement === focusCard, "scroll preserves card focus").toBe(true);
    state.selectedCardIds = new Set(state.cards.map((card) => card.id));
    renderView();
    expect(column.querySelectorAll(".workboard-card").length).toBeLessThan(20);
    state.selectedCardIds = new Set(["card-45"]);
    renderView();
    const selectedCard = expectDefined(row("card-45")?.querySelector("article"), "selected card");
    const clear = requireButton(container, "Clear selection");
    clear.focus();
    clear.click();
    renderView();
    expect(document.activeElement).toBe(selectedCard);
    expect(state.selectedCardIds.size).toBe(0);

    selectedCard.click();
    renderView();
    expect(state.detailCardId).toBe("card-45");
    expect(
      vi.mocked(workboardTestHost().host.components.mountDialog).mock.lastCall?.[1],
    ).toHaveProperty("returnFocusTarget", selectedCard);
    const close = expectDefined(
      container.querySelector<HTMLButtonElement>(".workboard-detail__close"),
      "detail close button",
    );
    close.focus();
    viewport.dispatchEvent(new Event("scroll"));
    renderView();
    close.click();
    renderView();
    // The SDK may return focus after inertness clears; its exact target must survive disposal.
    expect(state.detailCardId).toBeNull();
    expect(row("card-45")?.querySelector("article")).toBe(selectedCard);
    expect(selectedCard.isConnected).toBe(true);

    state.draggedCardId = "card-59";
    renderView();
    const edge = expectDefined(row("card-5"), "last visible ordinary row");
    expect(row("card-6")).toBeNull();
    vi.spyOn(edge, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 960, 320, 180));
    edge.dispatchEvent(
      new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY: 1100 }),
    );
    renderView();
    expect(state.dragBeforeCardId).toBe("card-6");
    expect(row("card-6")?.classList.contains("workboard-column__item--drop-before")).toBe(true);
  });

  it("keeps the visible card anchored through measured resizing, width, layout, and live insertion", async () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.viewMode = "board";
    state.cards = Array.from({ length: 60 }, (_, index) =>
      createWorkboardCard({ id: `card-${index}`, position: (index + 1) * 1000 }),
    );
    renderView();
    const viewport = expectDefined(
      container.querySelector<HTMLElement>(".workboard-column--todo .workboard-column__cards"),
      "column viewport",
    );
    let width = 320;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => width },
    });
    const row = (id: string) =>
      expectDefined(
        viewport.querySelector<HTMLElement>(`.workboard-column__item[data-card-id="${id}"]`),
        id,
      );
    const resize = (target: Element, height: number) => {
      for (const observer of expectDefined(observers.get(target), "observed element")) {
        observer.deliver(target, height);
      }
      flush();
    };
    expect(await settleFrames()).toBeLessThan(8);
    resize(row("card-0"), 180);
    await settleFrames();
    viewport.scrollTop = 1800;
    viewport.dispatchEvent(new Event("scroll"));
    renderView();
    const anchor = expectDefined(
      [...viewport.querySelectorAll<HTMLElement>(".workboard-column__item")].find((element) => {
        const top = Number.parseFloat(element.style.top);
        return top >= viewport.scrollTop && top < viewport.scrollTop + 400;
      }),
      "visible anchor row",
    );
    const anchorId = expectDefined(anchor.dataset.cardId, "anchor ID");
    const anchorOffset = Number.parseFloat(anchor.style.top) - viewport.scrollTop;
    const expectAnchored = () => {
      expect(row(anchorId)).toBe(anchor);
      expect(Number.parseFloat(anchor.style.top) - viewport.scrollTop).toBe(anchorOffset);
    };
    resize(row("card-0"), 240);
    expect(await settleFrames()).toBeLessThan(8);
    expect(viewport.scrollTop).toBe(1860);
    expectAnchored();
    state.cards = state.cards.map((card) => ({ ...card }));
    renderView();
    expectAnchored();

    width = 480;
    resize(viewport, 400);
    expect(await settleFrames()).toBeLessThan(8);
    resize(row("card-0"), 150);
    await settleFrames();
    expectAnchored();

    state.layout = "compact";
    renderView();
    expect(await settleFrames()).toBeLessThan(8);
    resize(row("card-0"), 120);
    await settleFrames();
    expectAnchored();
    state.cards = [createWorkboardCard({ id: "inserted", position: 0 }), ...state.cards];
    renderView();
    expect(await settleFrames()).toBeLessThan(8);
    expectAnchored();

    resize(anchor, 2000);
    await settleFrames();
    viewport.scrollTop += 600;
    viewport.dispatchEvent(new Event("scroll"));
    renderView();
    const deepOffset = Number.parseFloat(anchor.style.top) - viewport.scrollTop;
    const first = expectDefined(state.cards[0], "first card");
    state.cards = [
      first,
      createWorkboardCard({ id: "inserted-offscreen", position: first.position + 500 }),
      ...state.cards.slice(1),
    ];
    renderView();
    await settleFrames();
    expect(row(anchorId)).toBe(anchor);
    expect(Number.parseFloat(anchor.style.top) - viewport.scrollTop).toBe(deepOffset);

    const spacer = expectDefined(
      viewport.querySelector<HTMLElement>(".workboard-column__window"),
      "column spacer",
    );
    let clampedTop = viewport.scrollTop;
    // Browsers clamp against committed scroll geometry, including between animation frames.
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => clampedTop,
      set: (value: number) => {
        const maximum = Math.max(0, Number.parseFloat(spacer.style.height) - viewport.clientHeight);
        clampedTop = Math.max(0, Math.min(value, maximum));
      },
    });
    viewport.scrollTop = Number.MAX_SAFE_INTEGER;
    viewport.dispatchEvent(new Event("scroll"));
    renderView();
    await settleFrames();
    const lastRow = row("card-59");
    const bottomOffset = Number.parseFloat(lastRow.style.top) - viewport.scrollTop;
    const bottomTop = viewport.scrollTop;
    resize(row(first.id), 360);
    await settleFrames();
    expect(viewport.scrollTop).toBe(bottomTop + 180);
    expect(row("card-59")).toBe(lastRow);
    expect(Number.parseFloat(lastRow.style.top) - viewport.scrollTop).toBe(bottomOffset);

    resize(row(first.id), 120);
    let clampEvents = 0;
    await settleFrames(() => {
      const maximum = Number.parseFloat(spacer.style.height) - viewport.clientHeight;
      if (clampedTop > maximum) {
        // Native layout clamps after the spacer commits, before the next animation frame.
        viewport.scrollTop = maximum;
        viewport.dispatchEvent(new Event("scroll"));
        clampEvents++;
      }
    });
    expect(clampEvents).toBe(1);
    expect(viewport.scrollTop).toBe(bottomTop - 60);
    expect(Number.parseFloat(lastRow.style.top) - viewport.scrollTop).toBe(bottomOffset);

    resize(row(first.id), 360);
    let userScrollTop: number | undefined;
    await settleFrames(() => {
      if (userScrollTop === undefined) {
        viewport.scrollTop -= 600;
        userScrollTop = viewport.scrollTop;
        viewport.dispatchEvent(new Event("scroll"));
      }
    });
    expect(viewport.scrollTop).toBe(userScrollTop);

    viewport.scrollTop = Number.MAX_SAFE_INTEGER;
    viewport.dispatchEvent(new Event("scroll"));
    renderView();
    await settleFrames();
    const removalOffset = Number.parseFloat(lastRow.style.top) - viewport.scrollTop;
    const beforeRemovalTop = viewport.scrollTop;
    state.cards = state.cards.filter((card) => card.id !== first.id);
    renderView();
    // Membership commits directly, so native clamping can precede the first layout frame.
    viewport.scrollTop = beforeRemovalTop;
    expect(viewport.scrollTop).toBeLessThan(beforeRemovalTop);
    viewport.dispatchEvent(new Event("scroll"));
    await settleFrames();
    expect(Number.parseFloat(lastRow.style.top) - viewport.scrollTop).toBe(removalOffset);
  });
});
