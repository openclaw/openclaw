import type { TabId } from "./ui-types.js";

function revealTab(tab: HTMLElement) {
  const nav = tab.parentElement;
  if (!nav) {
    return;
  }
  const navRect = nav.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const left = navRect.left + nav.clientLeft;
  const right = left + nav.clientWidth;
  // Native focus can leave a tab partly clipped. Move only this scrollport;
  // scrollIntoView would also move ancestors and the page.
  if (tabRect.left < left) {
    nav.scrollLeft += tabRect.left - left;
  } else if (tabRect.right > right) {
    nav.scrollLeft += tabRect.right - right;
  }
}

export function bindTabNavigation(root: HTMLElement, onSelect: (tab: TabId) => void) {
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((node) => {
    node.addEventListener("focus", () => revealTab(node));
    node.addEventListener("click", () => {
      // SAFETY: renderTabBar emits these data-tab values from its typed TabId list.
      const nextTab = node.dataset.tab as TabId | undefined;
      if (nextTab) {
        onSelect(nextTab);
      }
    });
  });
}
