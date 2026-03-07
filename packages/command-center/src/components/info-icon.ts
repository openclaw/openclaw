import type { PanelHelpInfo } from "../api";
import { showHoverCard } from "./hover-card";

/**
 * Wire all info icons (&#9432;) on the page to their hover cards.
 *
 * Info icons are identified by the `data-panel-key` attribute.
 */
export function wireInfoIcons(guideData: Record<string, PanelHelpInfo>): void {
  document.querySelectorAll<HTMLButtonElement>(".info-icon[data-panel-key]").forEach((btn) => {
    const key = btn.dataset.panelKey ?? "";
    const info = guideData[key];
    if (!info) {
      return;
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      showHoverCard(btn, info);
    });
  });
}
