export function closeWorkboardPopoverOnAction(event: Event) {
  if (!(event.target instanceof Element) || !event.target.closest("button")) {
    return;
  }
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.hidePopover();
  }
}

export function workboardPopoverRef(align: "start" | "end" = "start", hover = false) {
  let dispose = () => {};
  return (element: Element | undefined) => {
    dispose();
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const sibling = element.previousElementSibling;
    const trigger = sibling instanceof HTMLElement ? sibling : null;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    const position = () => {
      if (!element.matches(":popover-open")) {
        return;
      }
      const anchor = trigger?.getBoundingClientRect();
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
      const panel = element.getBoundingClientRect();
      const left = align === "end" ? anchor.right - panel.width : anchor.left;
      element.style.left = `${Math.max(12, Math.min(left, innerWidth - panel.width - 12))}px`;
      element.style.top = `${opensBelow ? anchor.bottom + 6 : Math.max(12, anchor.top - panel.height - 6)}px`;
    };
    const toggle = () => {
      element.previousElementSibling?.setAttribute(
        "aria-expanded",
        String(element.matches(":popover-open")),
      );
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
      if (!hover && element.previousElementSibling instanceof HTMLElement) {
        element.previousElementSibling.focus({ preventScroll: true });
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
          !trigger?.matches(":hover, :focus-within") &&
          !element.matches(":hover, :focus-within")
        ) {
          element.hidePopover();
        }
      }, 150);
    };
    if (hover) {
      trigger?.addEventListener("pointerenter", enter);
      trigger?.addEventListener("pointerleave", leave);
      trigger?.addEventListener("focusin", show);
      trigger?.addEventListener("focusout", leave);
      trigger?.addEventListener("keydown", keydown);
      element.addEventListener("pointerenter", enter);
      element.addEventListener("pointerleave", leave);
    }
    element.addEventListener("toggle", toggle);
    element.addEventListener("keydown", keydown);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    let frame = requestAnimationFrame(position);
    const beforeToggle = () => {
      // Position before the first paint; the toggle event can arrive after it.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    element.addEventListener("beforetoggle", beforeToggle);
    dispose = () => {
      clearTimeout(hoverTimer);
      if (hover) {
        trigger?.removeEventListener("pointerenter", enter);
        trigger?.removeEventListener("pointerleave", leave);
        trigger?.removeEventListener("focusin", show);
        trigger?.removeEventListener("focusout", leave);
        trigger?.removeEventListener("keydown", keydown);
        element.removeEventListener("pointerenter", enter);
        element.removeEventListener("pointerleave", leave);
      }
      cancelAnimationFrame(frame);
      element.removeEventListener("beforetoggle", beforeToggle);
      element.removeEventListener("toggle", toggle);
      element.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  };
}
