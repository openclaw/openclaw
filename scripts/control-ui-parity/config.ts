const imageClippingReason =
  "Image clipping paints differently between runs, even under software rasterization.";
const menuBackdropReason =
  "The backdrop-filtered mobile menu rasterizes its SVG icons differently between runs.";

// Measured in complete same-SHA pairs. Keep exact scene/profile IDs so other
// captures and structural failures retain their normal comparison gates.
export const KNOWN_NONDETERMINISTIC_SHOTS: ReadonlyMap<string, string> = new Map([
  ["route-apps--desktop-large-text", imageClippingReason],
  ["route-apps--mobile-light", imageClippingReason],
  ["route-apps--mobile-dark", imageClippingReason],
  ["route-apps--mobile-reduced-motion", imageClippingReason],
  // Forced colors removes the backdrop, and that profile stays identical.
  ["session-menu--mobile-light", menuBackdropReason],
  ["session-menu--mobile-dark", menuBackdropReason],
  ["session-menu--mobile-rtl", menuBackdropReason],
  ["session-menu--mobile-large-text", menuBackdropReason],
  ["session-menu--mobile-reduced-motion", menuBackdropReason],
]);
