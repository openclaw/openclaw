/**
 * tapTargetToCoords — Converts a tapTarget string (e.g. "toggle.clips")
 * to absolute pixel coordinates within the CutmvUIFrame card.
 *
 * Returns coordinates relative to the card's content area origin (0,0 = top-left
 * of the 22px-padded content inside CutmvUIFrame).
 *
 * These coords are used by both TapRipple and Cursor components which are
 * positioned absolutely within the InteractiveUICardElement wrapper.
 */
import { AnchorPx, buildConfigureOutputAnchors, DEFAULT_ANCHORS } from "./configureOutputAnchors";
import { CUTMV_PAD } from "./uiLayout";

/**
 * Resolve a tapTarget string to card-local pixel coords.
 *
 * @param tapTarget - Semantic target like "toggle.clips", "aspect.9:16", "button.start"
 * @param toggleLabels - Toggle labels from uiOptions (for dynamic anchor building)
 * @param aspectPills - Aspect pill labels from uiOptions
 * @returns {x, y} in card-local space (relative to CutmvUIFrame outer edge)
 */
export function tapTargetToCardCoords(
  tapTarget: string,
  toggleLabels?: string[],
  aspectPills?: string[],
): AnchorPx {
  // Build anchors for this specific config (or use defaults)
  const anchors =
    toggleLabels && aspectPills
      ? buildConfigureOutputAnchors(toggleLabels, aspectPills)
      : DEFAULT_ANCHORS;

  const anchor = anchors[tapTarget];

  if (anchor) {
    // Content-local → card-local (add padding offset)
    return {
      x: anchor.x + CUTMV_PAD,
      y: anchor.y + CUTMV_PAD,
    };
  }

  // Fallback: center of card content area
  return {
    x: 410, // ~820/2
    y: 260, // rough center
  };
}
