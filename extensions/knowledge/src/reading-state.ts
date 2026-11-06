/** Restore reading state by record/source identity, never by row position. */
function key(node: Element): string {
  const owner = node.closest<HTMLElement>("[data-reading-key]");
  const own = owner?.dataset.readingKey ?? "view";
  if (node === owner) {
    return own;
  }
  const label =
    node instanceof HTMLDetailsElement
      ? node.querySelector(":scope > summary")?.textContent
      : (node.getAttribute("aria-label") ?? node.textContent);
  return `${own}/${node.tagName}/${label ?? ""}`;
}

export function captureReadingState(content: HTMLElement) {
  const details = new Map(
    [...content.querySelectorAll("details")].map((node) => [key(node), node.open]),
  );
  const focused =
    document.activeElement instanceof HTMLElement && content.contains(document.activeElement)
      ? document.activeElement
      : undefined;
  const focusKey = focused ? key(focused) : undefined;
  const selection =
    focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? ([focused.selectionStart, focused.selectionEnd] as const)
      : undefined;
  const scroll: Array<{ node: Element; top: number; left: number }> = [];
  for (let node: Element | null = content; node; node = node.parentElement) {
    scroll.push({ node, top: node.scrollTop, left: node.scrollLeft });
  }
  const windowScroll = [window.scrollX, window.scrollY] as const;
  return {
    expanded(node: HTMLDetailsElement) {
      return details.get(key(node)) ?? node.open;
    },
    restore(target: HTMLElement) {
      for (const node of target.querySelectorAll("details")) {
        const open = details.get(key(node));
        if (open !== undefined) {
          node.open = open;
        }
      }
      if (focusKey) {
        const next = [
          ...target.querySelectorAll<HTMLElement>(
            "button, input, textarea, summary, a, [tabindex]",
          ),
        ].find((node) => key(node) === focusKey);
        next?.focus({ preventScroll: true });
        if (
          selection &&
          (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) &&
          selection[0] !== null
        ) {
          next.setSelectionRange(selection[0], selection[1]);
        }
      }
      for (const { node, top, left } of scroll) {
        node.scrollTop = top;
        node.scrollLeft = left;
      }
      window.scrollTo(windowScroll[0], windowScroll[1]);
    },
  };
}
