import { onSettled } from "solid-js";
import { listen } from "../../lib/listener.ts";

type StatusDismissal = {
  outside: (event: Event) => void;
  scroll: (event: Event) => void;
  escape: (event: KeyboardEvent) => void;
};
type PopoverEnvironment = {
  positions: Set<() => void>;
  statuses: Set<StatusDismissal>;
  stopPositions?: () => void;
  stopStatuses?: () => void;
};
const environments = new WeakMap<Document, PopoverEnvironment>();

function environmentFor(doc: Document): PopoverEnvironment {
  let environment = environments.get(doc);
  if (!environment) {
    environment = { positions: new Set(), statuses: new Set() };
    environments.set(doc, environment);
  }
  return environment;
}

function notifyEnvironment<T>(entries: Set<T>, deliver: (entry: T) => void) {
  const delivery = [...entries];
  for (const entry of delivery) {
    if (entries.has(entry)) {
      try {
        deliver(entry);
      } catch (error) {
        // Independent native listeners report errors without skipping their siblings.
        reportError(error);
      }
    }
  }
}

function observePopoverPosition(doc: Document, position: () => void): () => void {
  const view = doc.defaultView;
  if (!view) {
    return () => {};
  }
  const environment = environmentFor(doc);
  if (!environment.positions.size) {
    const update = () => notifyEnvironment(environment.positions, (notify) => notify());
    const stopResize = listen(view, "resize", update);
    const stopScroll = listen(view, "scroll", update, true);
    environment.stopPositions = () => {
      stopResize();
      stopScroll();
    };
  }
  environment.positions.add(position);
  return () => {
    if (!environment.positions.delete(position)) {
      return;
    }
    if (!environment.positions.size) {
      environment.stopPositions?.();
      environment.stopPositions = undefined;
    }
    if (!environment.positions.size && !environment.statuses.size) {
      environments.delete(doc);
    }
  };
}

/** Status dismissal is needed while open or while a hover deadline could still open it. */
export function observeWorkboardStatusDismissal(
  doc: Document,
  status: StatusDismissal,
): () => void {
  const environment = environmentFor(doc);
  if (!environment.statuses.size) {
    const stopScroll = listen(
      doc,
      "scroll",
      (event) => {
        notifyEnvironment(environment.statuses, (entry) => entry.scroll(event));
      },
      true,
    );
    const stopPointer = listen(
      doc,
      "pointerdown",
      (event) => {
        notifyEnvironment(environment.statuses, (entry) => entry.outside(event));
      },
      true,
    );
    const stopKey = listen(
      doc,
      "keydown",
      (event) => {
        notifyEnvironment(environment.statuses, (entry) => entry.escape(event));
      },
      true,
    );
    environment.stopStatuses = () => {
      stopScroll();
      stopPointer();
      stopKey();
    };
  }
  environment.statuses.add(status);
  return () => {
    if (!environment.statuses.delete(status)) {
      return;
    }
    if (!environment.statuses.size) {
      environment.stopStatuses?.();
      environment.stopStatuses = undefined;
    }
    if (!environment.positions.size && !environment.statuses.size) {
      environments.delete(doc);
    }
  };
}

export function closeWorkboardPopoverOnAction(event: Event) {
  if (!(event.target instanceof Element) || !event.target.closest("button")) {
    return;
  }
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.hidePopover();
  }
}

export function workboardPopoverRef(
  align: "start" | "end" = "start",
  hover = false,
  activeTrigger?: () => HTMLElement | undefined,
) {
  let panel!: HTMLElement;
  onSettled(() => {
    const element = panel;
    // Conditional Solid fragments have no sibling anchor until their DOM is committed.
    const trigger = () => {
      if (activeTrigger) {
        return activeTrigger();
      }
      const sibling = element.previousElementSibling;
      return sibling instanceof HTMLElement ? sibling : null;
    };
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    const position = () => {
      if (!element.matches(":popover-open")) {
        return;
      }
      const anchor = trigger()?.getBoundingClientRect();
      if (!anchor) {
        return;
      }
      const below = innerHeight - anchor.bottom - 18;
      const above = anchor.top - 18;
      const opensBelow = below >= Math.min(380, above);
      element.style.setProperty(
        "--workboard-popover-max-height",
        `${Math.max(64, opensBelow ? below : above)}px`,
      );
      const bounds = element.getBoundingClientRect();
      const left = align === "end" ? anchor.right - bounds.width : anchor.left;
      element.style.left = `${Math.max(12, Math.min(left, innerWidth - bounds.width - 12))}px`;
      element.style.top = `${opensBelow ? anchor.bottom + 6 : Math.max(12, anchor.top - bounds.height - 6)}px`;
    };
    let stopPosition: (() => void) | undefined;
    const synchronizePosition = () => {
      if (element.matches(":popover-open")) {
        stopPosition ??= observePopoverPosition(element.ownerDocument, position);
      } else {
        stopPosition?.();
        stopPosition = undefined;
      }
    };
    const toggle = () => {
      synchronizePosition();
      trigger()?.setAttribute("aria-expanded", String(element.matches(":popover-open")));
      position();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      clearTimeout(hoverTimer);
      if (!element.matches(":popover-open")) {
        return;
      }
      // The containing dialog must stay open when dismissing a nested menu.
      event.preventDefault();
      event.stopPropagation();
      element.hidePopover();
      if (!hover) {
        trigger()?.focus({ preventScroll: true });
      }
    };
    const show = () => {
      clearTimeout(hoverTimer);
      if (element.isConnected && !element.matches(":popover-open")) {
        element.showPopover();
        position();
      }
    };
    const enter = (event: Event) => {
      if (event instanceof PointerEvent && event.pointerType === "touch") {
        return;
      }
      clearTimeout(hoverTimer);
      if (element.matches(":popover-open")) {
        return;
      }
      hoverTimer = setTimeout(show, 200);
    };
    const leave = () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (
          !trigger()?.matches(":hover, :focus-within") &&
          !element.matches(":hover, :focus-within")
        ) {
          element.hidePopover();
        }
      }, 150);
    };
    if (hover) {
      trigger()?.addEventListener("pointerenter", enter);
      trigger()?.addEventListener("pointerleave", leave);
      trigger()?.addEventListener("focusin", show);
      trigger()?.addEventListener("focusout", leave);
      trigger()?.addEventListener("keydown", keydown);
      element.addEventListener("pointerenter", enter);
      element.addEventListener("pointerleave", leave);
    }
    element.addEventListener("toggle", toggle);
    element.addEventListener("keydown", keydown);
    let frame: number | undefined;
    const beforeToggle = () => {
      // Position before the first paint; the toggle event can arrive after it.
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        frame = undefined;
        position();
      });
    };
    element.addEventListener("beforetoggle", beforeToggle);
    synchronizePosition();
    if (element.matches(":popover-open")) {
      beforeToggle();
    }
    return () => {
      clearTimeout(hoverTimer);
      if (hover) {
        trigger()?.removeEventListener("pointerenter", enter);
        trigger()?.removeEventListener("pointerleave", leave);
        trigger()?.removeEventListener("focusin", show);
        trigger()?.removeEventListener("focusout", leave);
        trigger()?.removeEventListener("keydown", keydown);
        element.removeEventListener("pointerenter", enter);
        element.removeEventListener("pointerleave", leave);
      }
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      stopPosition?.();
      element.removeEventListener("beforetoggle", beforeToggle);
      element.removeEventListener("toggle", toggle);
      element.removeEventListener("keydown", keydown);
    };
  });
  return (element: HTMLElement) => {
    panel = element;
  };
}
