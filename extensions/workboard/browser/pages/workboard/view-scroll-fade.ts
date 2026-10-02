export function workboardScrollFadeRef() {
  let dispose = () => {};
  return (element: Element | undefined) => {
    dispose();
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const update = () => {
      const overflow = getComputedStyle(element).overflowY;
      const maxScroll = element.scrollHeight - element.clientHeight;
      const scrollable = maxScroll > 1 && (overflow === "auto" || overflow === "scroll");
      const top = scrollable ? Math.max(0, element.scrollTop) : 0;
      const bottom = scrollable ? Math.max(0, maxScroll - element.scrollTop) : 0;
      element.toggleAttribute("data-scrollable", scrollable);
      element.style.setProperty("--workboard-fade-top", `${Math.min(top, 24)}px`);
      element.style.setProperty("--workboard-fade-bottom", `${Math.min(bottom, 24)}px`);
      element.style.setProperty(
        "--workboard-scrollbar-width",
        `${element.offsetWidth - element.clientWidth}px`,
      );
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    // Ref runs before children commit. Observe their final sizes too:
    // async content can grow without resizing the scroll viewport itself.
    const frame = requestAnimationFrame(() => {
      update();
      observer?.observe(element);
      for (const child of element.children) {
        observer?.observe(child);
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
