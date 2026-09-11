export function workboardPopoverRef(align: "start" | "end" = "start") {
  let dispose = () => {};
  return (element: Element | undefined) => {
    dispose();
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const position = () => {
      if (!element.matches(":popover-open")) {
        return;
      }
      const trigger = element.previousElementSibling?.getBoundingClientRect();
      if (!trigger) {
        return;
      }
      const below = innerHeight - trigger.bottom - 18;
      const above = trigger.top - 18;
      const opensBelow = below >= Math.min(380, above);
      element.style.setProperty(
        "--workboard-popover-max-height",
        `${Math.max(64, opensBelow ? below : above)}px`,
      );
      const panel = element.getBoundingClientRect();
      const left = align === "end" ? trigger.right - panel.width : trigger.left;
      element.style.left = `${Math.max(12, Math.min(left, innerWidth - panel.width - 12))}px`;
      element.style.top = `${opensBelow ? trigger.bottom + 6 : Math.max(12, trigger.top - panel.height - 6)}px`;
    };
    const toggle = () => {
      element.previousElementSibling?.setAttribute(
        "aria-expanded",
        String(element.matches(":popover-open")),
      );
      position();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !element.matches(":popover-open")) {
        return;
      }
      // The containing dialog must stay open when dismissing a nested menu.
      event.preventDefault();
      event.stopPropagation();
      element.hidePopover();
      if (element.previousElementSibling instanceof HTMLElement) {
        element.previousElementSibling.focus({ preventScroll: true });
      }
    };
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
      cancelAnimationFrame(frame);
      element.removeEventListener("beforetoggle", beforeToggle);
      element.removeEventListener("toggle", toggle);
      element.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  };
}
