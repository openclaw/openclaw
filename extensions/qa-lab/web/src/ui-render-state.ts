export function captureRenderState(root: HTMLElement) {
  const focusedElement = root.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focusedElement?.id || null;
  const tabBar = root.querySelector<HTMLElement>("nav.tab-bar");
  const focusedTab =
    focusedElement instanceof HTMLButtonElement && focusedElement.parentElement === tabBar
      ? focusedElement.dataset.tab
      : null;
  const tabScrollLeft = tabBar?.scrollLeft ?? 0;
  const tabClientWidth = tabBar?.clientWidth ?? 0;
  return { focusedId, focusedTab, tabScrollLeft, tabClientWidth };
}

export function restoreRenderState(
  root: HTMLElement,
  snapshot: ReturnType<typeof captureRenderState>,
) {
  const { focusedId, focusedTab, tabScrollLeft, tabClientWidth } = snapshot;
  const tabBar = root.querySelector<HTMLElement>("nav.tab-bar");
  const sameWidth = tabBar?.clientWidth === tabClientWidth;
  // A resized scrollport needs the focus handler's reveal to survive. Unchanged
  // polling instead preserves the user's viewport, even after focus reveals a tab.
  if (tabBar && !sameWidth) {
    tabBar.scrollLeft = tabScrollLeft;
  }
  if (focusedTab) {
    tabBar
      ?.querySelector<HTMLButtonElement>(`button[data-tab="${CSS.escape(focusedTab)}"]`)
      ?.focus({ preventScroll: true });
  } else if (focusedId) {
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(focusedId)}`);
    if (el && "focus" in el) {
      el.focus();
    }
  }
  if (tabBar && sameWidth) {
    tabBar.scrollLeft = tabScrollLeft;
  }
}
