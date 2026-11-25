import { createMemo, createSignal, onSettled } from "solid-js";
import type { createElementRefs } from "../../lib/element-refs.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";

type Measurement = { layout: string; height: number };

/** A column owns its scrollport. Lists and widgets retain their existing layout. */
export function createWorkboardColumnWindow(input: {
  cards: () => WorkboardCard[];
  enabled: () => boolean;
  layout: () => string;
  retained: () => readonly (string | null | undefined)[];
  rows: ReturnType<typeof createElementRefs<HTMLElement>>;
}) {
  let viewport: HTMLDivElement | undefined;
  let content: HTMLDivElement;
  let observer: ResizeObserver | undefined;
  let observeViewport: (() => void) | undefined;
  let frame = 0;
  let anchor: { id: string; offset: number } | undefined;
  let measuredLayout: string | undefined;
  let measurementsPending = false;
  const measured = new Map<string, Measurement>();
  const [measureRevision, setMeasureRevision] = createSignal(0);
  const [focused, setFocused] = createSignal<string>();
  const [view, setView] = createSignal({ top: 0, height: 600, width: 0, gap: 12 });
  const rowGap = createMemo(() => view().gap);
  const active = createMemo(() => input.enabled() && input.cards().length > 24);
  const describePositions = (layout: string, gap: number) => {
    let top = 0;
    return input.cards().map((card) => {
      const known = measured.get(card.id);
      // Offscreen cards keep their last measured height until visited again.
      const height = known?.layout === layout ? known.height : 180;
      const item = { card, top, height };
      top += height + gap;
      return item;
    });
  };
  const positions = createMemo(() => {
    measureRevision();
    return describePositions(input.layout(), rowGap());
  });
  const byId = createMemo(() => new Map(positions().map((item) => [item.card.id, item])));
  const height = createMemo(() => {
    const last = positions().at(-1);
    return last ? last.top + last.height : 0;
  });
  const visible = createMemo(() => {
    if (!active()) {
      return undefined;
    }
    const items = positions();
    const current = view();
    const first = items.findIndex((item) => item.top + item.height > current.top);
    const beyond = items.findIndex((item) => item.top >= current.top + current.height);
    const start = first < 0 ? items.length : Math.max(0, first - 2);
    const end = beyond < 0 ? items.length : Math.min(items.length, beyond + 2);
    const pins = new Set(input.retained());
    const focusedIndex = items.findIndex((item) => item.card.id === focused());
    return new Set(
      items
        .filter(
          (item, index) =>
            (index >= start && index < end) ||
            index === 0 ||
            index === items.length - 1 ||
            pins.has(item.card.id) ||
            (focusedIndex >= 0 && Math.abs(index - focusedIndex) <= 1),
        )
        .map((item) => item.card.id),
    );
  });
  const captureAnchor = (top: number, items = positions()) => {
    const item = items.findLast((entry) => entry.top <= top);
    anchor = item ? { id: item.card.id, offset: top - item.top } : undefined;
  };
  const publishViewport = (top: number, viewportHeight: number, width: number, gap: number) => {
    setView((previous) =>
      previous.top === top &&
      previous.height === viewportHeight &&
      previous.width === width &&
      previous.gap === gap
        ? previous
        : { top, height: viewportHeight, width, gap },
    );
  };
  const settleLayout = () => {
    frame = 0;
    const element = viewport;
    if (!element) {
      return;
    }
    const keys = new Set(input.cards().map((card) => card.id));
    for (const key of measured.keys()) {
      if (!keys.has(key)) {
        measured.delete(key);
      }
    }
    if (!active()) {
      measurementsPending = false;
      observer?.disconnect();
      observer = undefined;
      anchor = undefined;
      const current = view();
      publishViewport(element.scrollTop, current.height, current.width, current.gap);
      return;
    }
    observeViewport?.();
    const viewportHeight = element.clientHeight;
    const width = element.clientWidth;
    const gap = Number.parseFloat(getComputedStyle(element).rowGap) || 0;
    const previous = view();
    const layout = input.layout();
    const layoutChanged =
      (previous.width > 0 && previous.width !== width) || measuredLayout !== layout;
    const measurementsChanged = measurementsPending;
    if (layoutChanged) {
      measured.clear();
      measuredLayout = layout;
      measurementsPending = false;
      setMeasureRevision((value) => value + 1);
    } else if (measurementsPending) {
      measurementsPending = false;
      setMeasureRevision((value) => value + 1);
    }
    for (const card of input.cards()) {
      const row = input.rows.get(card.id);
      const known = measured.get(card.id);
      if (row && (!known || known.layout !== layout)) {
        // Layout invalidation needs fresh supplied geometry even if the height stayed the same.
        observer?.unobserve(row);
        observer?.observe(row);
      }
    }
    if (layoutChanged || measurementsChanged || previous.gap !== gap) {
      // Let the new spacer commit before restoring an anchor into its geometry.
      publishViewport(element.scrollTop, viewportHeight, width, gap);
      scheduleLayout();
      return;
    }
    const next = describePositions(layout, gap);
    const item = anchor && next.find((entry) => entry.card.id === anchor?.id);
    // Preserve the visible card when measured heights or live ordering change above it.
    if (item && anchor && element.scrollTop !== item.top + anchor.offset) {
      element.scrollTop = item.top + anchor.offset;
    }
    captureAnchor(element.scrollTop, next);
    publishViewport(element.scrollTop, viewportHeight, width, gap);
  };
  const scheduleLayout = () => {
    if (!frame) {
      frame = requestAnimationFrame(settleLayout);
    }
  };
  return {
    active,
    includes: (id: string) => visible()?.has(id) ?? true,
    height: () => (active() ? `${height()}px` : undefined),
    layoutKey: () => `${active()}:${input.layout()}`,
    contentRef: (element: HTMLDivElement) => {
      content = element;
    },
    top: (id: string) => byId().get(id)?.top ?? 0,
    scroll(this: void, event: Event) {
      if (!active()) {
        return;
      }
      const element = event.currentTarget;
      if (!(element instanceof HTMLElement)) {
        return;
      }
      captureAnchor(element.scrollTop);
      const current = view();
      publishViewport(element.scrollTop, current.height, current.width, current.gap);
    },
    focus(this: void, event: FocusEvent) {
      const row =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(".workboard-column__item")
          : null;
      // Keep one remembered row across external focus for deferred dialog return focus.
      setFocused(row?.dataset.cardId);
    },
    beforeAt(this: void, clientY: number, draggedId: string | null): string | null | undefined {
      if (!active() || !viewport) {
        return undefined;
      }
      const top = clientY - viewport.getBoundingClientRect().top + viewport.scrollTop;
      const items = positions();
      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const item = items[middle]!;
        if (top < item.top + item.height / 2) {
          high = middle;
        } else {
          low = middle + 1;
        }
      }
      if (items[low]?.card.id === draggedId) {
        low++;
      }
      return items[low]?.card.id ?? null;
    },
    viewportRef() {
      let element: HTMLDivElement;
      onSettled(() => {
        viewport = element;
        const initialLayout = input.layout();
        const gap = Number.parseFloat(getComputedStyle(element).rowGap) || 0;
        // Remounts keep the previous size so settlement can invalidate old measurements.
        if (view().width === 0) {
          measuredLayout = initialLayout;
          publishViewport(element.scrollTop, element.clientHeight, element.clientWidth, gap);
        }
        captureAnchor(element.scrollTop, describePositions(initialLayout, gap));
        observeViewport = () => {
          if (observer) {
            return;
          }
          observer = new ResizeObserver((entries) => {
            let changed = false;
            for (const entry of entries) {
              const id = entry.target.getAttribute("data-card-id");
              if (!id || !byId().has(id)) {
                continue;
              }
              const measuredHeight = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
              const old = measured.get(id);
              const layout = input.layout();
              if (
                measuredHeight > 0 &&
                (!old || old.height !== measuredHeight || old.layout !== layout)
              ) {
                measured.set(id, { layout, height: measuredHeight });
                changed = true;
              }
            }
            if (changed) {
              // Publish outside resize delivery so rendering cannot trigger another resize loop.
              measurementsPending = true;
            }
            scheduleLayout();
          });
          observer.observe(element);
          for (const card of input.cards()) {
            const row = input.rows.get(card.id);
            if (row) {
              observer.observe(row);
            }
          }
        };
        if (active()) {
          observeViewport();
        }
        const mutations = new MutationObserver(scheduleLayout);
        // Stable slots also signal offscreen insertions that leave visible membership unchanged.
        mutations.observe(content, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["data-window-layout"],
        });
        scheduleLayout();
        return () => {
          cancelAnimationFrame(frame);
          frame = 0;
          observer?.disconnect();
          observer = undefined;
          measurementsPending = false;
          observeViewport = undefined;
          mutations.disconnect();
          if (viewport === element) {
            viewport = undefined;
          }
        };
      });
      return (node: HTMLDivElement) => {
        element = node;
      };
    },
    rowRef() {
      let element: HTMLDivElement;
      onSettled(() => {
        const id = element.dataset.cardId;
        const initialHeight = element.getBoundingClientRect().height;
        if (active() && id && initialHeight > 0) {
          const layout = input.layout();
          measuredLayout ??= layout;
          measured.set(id, { layout, height: initialHeight });
          setMeasureRevision((value) => value + 1);
        }
        observer?.observe(element);
        return () => observer?.unobserve(element);
      });
      return (node: HTMLDivElement) => {
        element = node;
      };
    },
  };
}
