export function boardScrollEdgesRef() {
  let dispose = () => {};
  return (element: Element | undefined) => {
    dispose();
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const update = () => {
      const first = element.firstElementChild?.getBoundingClientRect();
      const last = element.lastElementChild?.getBoundingClientRect();
      const viewport = element.getBoundingClientRect();
      // Physical edges also work when RTL reverses scrollLeft's sign.
      element.parentElement?.toggleAttribute(
        "data-scroll-left",
        Boolean(first && last && Math.min(first.left, last.left) < viewport.left - 1),
      );
      element.parentElement?.toggleAttribute(
        "data-scroll-right",
        Boolean(first && last && Math.max(first.right, last.right) > viewport.right + 1),
      );
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    const frame = requestAnimationFrame(() => {
      update();
      observer?.observe(element);
      for (const column of element.children) {
        observer?.observe(column);
      }
    });
    element.addEventListener("scroll", update, { passive: true });
    dispose = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      element.removeEventListener("scroll", update);
    };
  };
}
