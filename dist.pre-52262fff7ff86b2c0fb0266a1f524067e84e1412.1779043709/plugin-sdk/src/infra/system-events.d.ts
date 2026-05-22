import type { DeliveryContext } from "../utils/delivery-context.types.js";
export type SystemEvent = {
    text: string;
    ts: number;
    contextKey?: string | null;
    deliveryContext?: DeliveryContext;
    forceSenderIsOwnerFalse?: boolean;
    /** @deprecated Use forceSenderIsOwnerFalse. Kept for installed plugin compatibility. */
    trusted?: boolean;
    /**
     * W3C `traceparent` captured at enqueue-time so the substrate-queue drain can
     * reconstruct the producer trace at announce/deliver time. Per RFC §6.7 the
     * substrate queue is an asynchronous boundary (enqueue turn != drain turn,
     * possibly across a gateway restart), so trace context rides on the payload
     * itself rather than on a runtime ambient. Optional and additive — invalid
     * traceparent values are silently dropped at enqueue-time so producers never
     * fail-the-write on a malformed header.
     */
    traceparent?: string;
};
type SystemEventOptions = {
    sessionKey: string;
    contextKey?: string | null;
    deliveryContext?: DeliveryContext;
    forceSenderIsOwnerFalse?: boolean;
    /** @deprecated Use forceSenderIsOwnerFalse. Kept for installed plugin compatibility. */
    trusted?: boolean;
    /**
     * Optional W3C `traceparent` to attach to the queued event for cross-boundary
     * trace correlation. Invalid values are silently dropped (additive contract:
     * a malformed traceparent never prevents an enqueue).
     */
    traceparent?: string;
};
export declare function isSystemEventContextChanged(sessionKey: string, contextKey?: string | null): boolean;
export declare function enqueueSystemEvent(text: string, options: SystemEventOptions): boolean;
export declare function drainSystemEventEntries(sessionKey: string): SystemEvent[];
export declare function consumeSystemEventEntries(sessionKey: string, consumedEntries: readonly SystemEvent[]): SystemEvent[];
export declare function consumeSelectedSystemEventEntries(sessionKey: string, consumedEntries: readonly SystemEvent[]): SystemEvent[];
export declare function drainSystemEvents(sessionKey: string): string[];
/**
 * Remove system events matching a predicate without draining the entire queue.
 * Returns the removed events; non-matching events stay queued.
 */
export declare function removeSystemEvents(sessionKey: string, predicate: (event: SystemEvent) => boolean): SystemEvent[];
export declare function peekSystemEventEntries(sessionKey: string): SystemEvent[];
export declare function peekSystemEvents(sessionKey: string): string[];
export declare function hasSystemEvents(sessionKey: string): boolean;
export declare function resolveSystemEventDeliveryContext(events: readonly SystemEvent[]): DeliveryContext | undefined;
export declare function resetSystemEventsForTest(): void;
export {};
