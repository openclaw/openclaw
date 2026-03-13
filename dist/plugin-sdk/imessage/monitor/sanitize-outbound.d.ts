/**
 * Strip all assistant-internal scaffolding from outbound text before delivery.
 * Applies reasoning/thinking tag removal, memory tag removal, and
 * model-specific internal separator stripping.
 */
export declare function sanitizeOutboundText(text: string): string;
