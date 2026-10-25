import "../../test/dom.setup.ts";
import { render } from "@solidjs/web";
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { CardMeta } from "./view-card-content.tsx";

afterEach(() => vi.unstubAllGlobals());

it("leaves settled labels untouched until their available width changes", () => {
  let resize: ResizeObserverCallback = () => {};
  let frame: FrameRequestCallback = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = render(
    () =>
      createComponent(CardMeta, {
        card: createWorkboardCard({ labels: ["alpha", "beta"] }),
        archived: false,
      }),
    container,
  );
  flush();
  const labels = container.querySelector<HTMLElement>(".workboard-card__labels")!;
  const chips = [...labels.querySelectorAll<HTMLElement>(".workboard-card__label")];
  const overflow = labels.querySelector<HTMLElement>(".workboard-card__label-overflow")!;
  let width = 100;
  Object.defineProperty(labels, "clientWidth", { get: () => width });
  for (const chip of chips) {
    vi.spyOn(chip, "getBoundingClientRect").mockReturnValue({ width: 60 } as DOMRect);
  }
  vi.spyOn(overflow, "getBoundingClientRect").mockReturnValue({ width: 20 } as DOMRect);
  const mutations = new MutationObserver(() => {});
  mutations.observe(labels, { attributes: true, childList: true, subtree: true });
  const notifyResize = () =>
    resize(
      [
        {
          target: labels,
          contentRect: new DOMRect(0, 0, width, 24),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    );
  try {
    frame(0);
    expect(chips.map((chip) => chip.hidden)).toEqual([false, true]);
    expect(overflow.textContent).toBe("+1");
    mutations.takeRecords();
    notifyResize();
    expect(mutations.takeRecords()).toEqual([]);
    width = 200;
    notifyResize();
    frame(0);
    expect(chips.map((chip) => chip.hidden)).toEqual([false, false]);
    expect(overflow.hidden).toBe(true);
    width = 100;
    notifyResize();
    frame(0);
    expect(chips.map((chip) => chip.hidden)).toEqual([false, true]);
    expect(overflow.title).toBe("beta");
  } finally {
    mutations.disconnect();
    root();
  }
});

it("shares label resize observation and retires targets independently", () => {
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const first = document.createElement("div");
  const second = document.createElement("div");
  document.body.append(first, second);
  const mountLabels = (container: HTMLElement, count: number) =>
    render(
      () =>
        Array.from({ length: count }, (_, index) =>
          createComponent(CardMeta, {
            card: createWorkboardCard({ id: `label-${index}`, labels: ["alpha", "beta"] }),
            archived: false,
          }),
        ),
      container,
    );
  const disposeFirst = mountLabels(first, 100);
  const disposeSecond = mountLabels(second, 20);
  flush();
  try {
    expect(first.querySelectorAll(".workboard-card__labels")).toHaveLength(100);
    expect(second.querySelectorAll(".workboard-card__labels")).toHaveLength(20);
    expect(observers).toHaveLength(1);
    expect(observers[0]!.targets.size).toBe(120);
    expect(
      [...observers[0]!.targets].every((target) => target.matches(".workboard-card__labels")),
    ).toBe(true);
    disposeFirst();
    expect(observers[0]!.targets.size).toBe(20);
    disposeSecond();
    expect(observers[0]!.targets.size).toBe(0);
  } finally {
    disposeFirst();
    disposeSecond();
  }
});

it("ignores a repeated retired ref cleanup after a sibling creates the next pool", () => {
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor() {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const [card, setCard] = createSignal(createWorkboardCard({ labels: ["retiring"] }));
  const containers = Array.from({ length: 3 }, () => document.createElement("div"));
  document.body.append(...containers);
  const disposeFirst = render(
    () =>
      createComponent(CardMeta, {
        get card() {
          return card();
        },
        archived: false,
      }),
    containers[0]!,
  );
  const disposers = [disposeFirst];
  try {
    flush();
    expect(observers).toHaveLength(1);
    setCard(createWorkboardCard({ labels: [] }));
    flush();
    expect(observers[0]!.targets.size).toBe(0);
    disposers.push(
      render(
        () =>
          createComponent(CardMeta, {
            card: createWorkboardCard({ labels: ["surviving"] }),
            archived: false,
          }),
        containers[1]!,
      ),
    );
    flush();
    expect(observers).toHaveLength(2);
    disposeFirst();
    disposers.push(
      render(
        () =>
          createComponent(CardMeta, {
            card: createWorkboardCard({ labels: ["new sibling"] }),
            archived: false,
          }),
        containers[2]!,
      ),
    );
    flush();
    expect(observers).toHaveLength(2);
    expect(observers[1]!.targets.size).toBe(2);
  } finally {
    for (const dispose of disposers) {
      dispose();
    }
  }
});
