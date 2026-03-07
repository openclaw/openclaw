/**
 * uiLayout — Constants + helpers for CutmvUIFrame / ConfigureOutputCard layout.
 *
 * Card is fixed at 820px wide with 22px padding.
 * Content area is 776px wide.
 * All anchor Y values are computed from the ConfigureOutputCard JSX layout.
 */

export type Rect = { x: number; y: number; w: number; h: number };

// ── CutmvUIFrame constants ──
export const CUTMV_CARD_W = 820;
export const CUTMV_PAD = 22;
export const CUTMV_CONTENT_W = CUTMV_CARD_W - CUTMV_PAD * 2; // 776

/**
 * Get card bounds in comp space.
 * The card is horizontally centered; vertically it's positioned by the
 * flex layout in renderElementScene (centered). We pass cardH as param
 * since ConfigureOutputCard has no fixed height — it grows with content.
 */
export const getCutmvCardRect = (
  compW: number,
  _compH: number,
  cardH: number,
  cardCenterY: number,
): Rect => {
  const x = Math.round((compW - CUTMV_CARD_W) / 2);
  const y = Math.round(cardCenterY - cardH / 2);
  return { x, y, w: CUTMV_CARD_W, h: cardH };
};

/**
 * Get content bounds inside the card (inset by CUTMV_PAD on all sides).
 */
export const getCutmvContentRect = (card: Rect): Rect => ({
  x: card.x + CUTMV_PAD,
  y: card.y + CUTMV_PAD,
  w: CUTMV_CONTENT_W,
  h: card.h - CUTMV_PAD * 2,
});
