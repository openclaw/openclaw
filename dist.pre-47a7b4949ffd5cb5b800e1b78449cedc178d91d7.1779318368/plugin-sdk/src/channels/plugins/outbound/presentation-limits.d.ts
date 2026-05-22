import type { MessagePresentation, MessagePresentationButton } from "../../../interactive/payload.js";
import type { ChannelPresentationCapabilities } from "../outbound.types.js";
/**
 * Adapt a portable presentation to the target channel's advertised capabilities.
 *
 * Unsupported controls are downgraded to text/context fallback blocks where possible, and
 * labels, values, rows, options, styles, disabled state, and text are clipped to channel limits.
 */
export declare function adaptMessagePresentationForChannel(params: {
    presentation: MessagePresentation;
    capabilities?: ChannelPresentationCapabilities;
}): MessagePresentation;
/** Return the subset of buttons that can still be rendered under action limits. */
export declare function applyPresentationActionLimits(buttons: readonly MessagePresentationButton[], capabilities?: ChannelPresentationCapabilities): MessagePresentationButton[];
/** Resolve an action page size that leaves room for reserved actions on the target channel. */
export declare function presentationPageSize(capabilities?: ChannelPresentationCapabilities, reservedActions?: number, maxPageSize?: number): number;
