import "../../test/dom.setup.ts";
import { render } from "@solidjs/web";
import { createComponent, flush } from "solid-js";
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
