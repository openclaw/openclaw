/**
 * layoutGate — Checks element boxes against safe zone bounds.
 *
 * If an element group exceeds safe zone:
 * - Auto-shift group up/down to fit
 * - Scale down 2-6% until passing
 *
 * Safe zone:
 * - Top: 8%
 * - Bottom: 10%
 * - Left/Right: 6%
 */

const SAFE_TOP = 0.08;
const SAFE_BOTTOM = 0.10;
const SAFE_LEFT = 0.06;
const SAFE_RIGHT = 0.06;

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LayoutGateResult = {
  /** Scale factor to apply (1.0 = no change, 0.94 = scaled down 6%) */
  scale: number;
  /** Y offset to apply (px, positive = shift down, negative = shift up) */
  offsetY: number;
  /** Whether the content needed adjustment */
  adjusted: boolean;
};

/**
 * Check if a content rect fits within safe zone, and compute corrections if not.
 *
 * @param contentRect - The bounding box of the content group (in comp space)
 * @param compW - Composition width
 * @param compH - Composition height
 * @param maxScaleDown - Maximum scale reduction (default 0.06 = can shrink by 6%)
 */
export function layoutGate(
  contentRect: Rect,
  compW: number,
  compH: number,
  maxScaleDown = 0.06,
): LayoutGateResult {
  const safeTop = compH * SAFE_TOP;
  const safeBottom = compH * (1 - SAFE_BOTTOM);
  const safeLeft = compW * SAFE_LEFT;
  const safeRight = compW * (1 - SAFE_RIGHT);
  const safeW = safeRight - safeLeft;
  const safeH = safeBottom - safeTop;

  let scale = 1;
  let offsetY = 0;
  let adjusted = false;

  // Check if content is wider than safe zone
  if (contentRect.width > safeW) {
    scale = Math.max(1 - maxScaleDown, safeW / contentRect.width);
    adjusted = true;
  }

  // Check if content is taller than safe zone
  const scaledH = contentRect.height * scale;
  if (scaledH > safeH) {
    const heightScale = safeH / contentRect.height;
    scale = Math.max(1 - maxScaleDown, Math.min(scale, heightScale));
    adjusted = true;
  }

  // After scaling, check vertical position
  const finalH = contentRect.height * scale;
  const contentTop = contentRect.y;
  const contentBottom = contentRect.y + finalH;

  // Shift up if content overflows bottom safe zone
  if (contentBottom > safeBottom) {
    offsetY = safeBottom - contentBottom;
    adjusted = true;
  }

  // Shift down if content overflows top safe zone
  if (contentTop + offsetY < safeTop) {
    offsetY = safeTop - contentTop;
    adjusted = true;
  }

  return { scale, offsetY, adjusted };
}

/**
 * Quick check: does a rect fit entirely within safe zone?
 */
export function isInSafeZone(rect: Rect, compW: number, compH: number): boolean {
  const safeTop = compH * SAFE_TOP;
  const safeBottom = compH * (1 - SAFE_BOTTOM);
  const safeLeft = compW * SAFE_LEFT;
  const safeRight = compW * (1 - SAFE_RIGHT);

  return (
    rect.x >= safeLeft &&
    rect.y >= safeTop &&
    rect.x + rect.width <= safeRight &&
    rect.y + rect.height <= safeBottom
  );
}
