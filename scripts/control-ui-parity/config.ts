const imageClippingReason =
  "Image clipping paints differently between runs, even under software rasterization.";

// Measured in the complete same-SHA pair. Keep exact scene/profile IDs so other
// Apps captures and structural failures retain their normal comparison gates.
export const KNOWN_NONDETERMINISTIC_SHOTS: ReadonlyMap<string, string> = new Map([
  ["route-apps--mobile-light", imageClippingReason],
  ["route-apps--mobile-dark", imageClippingReason],
  ["route-apps--mobile-reduced-motion", imageClippingReason],
]);
