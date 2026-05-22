import { t as DeliveryContext } from "./delivery-context.types-C7zJv-CH.js";

//#region src/infra/system-events.d.ts
type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  sessionDeliveryAckId?: string;
  sessionDeliveryAckStateDir?: string;
  forceSenderIsOwnerFalse?: boolean; /** @deprecated Use forceSenderIsOwnerFalse. Kept for installed plugin compatibility. */
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
  sessionDeliveryAckId?: string;
  sessionDeliveryAckStateDir?: string;
  forceSenderIsOwnerFalse?: boolean; /** @deprecated Use forceSenderIsOwnerFalse. Kept for installed plugin compatibility. */
  trusted?: boolean;
  /**
   * Optional W3C `traceparent` to attach to the queued event for cross-boundary
   * trace correlation. Invalid values are silently dropped (additive contract:
   * a malformed traceparent never prevents an enqueue).
   */
  traceparent?: string;
};
declare function isSystemEventContextChanged(sessionKey: string, contextKey?: string | null): boolean;
declare function enqueueSystemEvent(text: string, options: SystemEventOptions): boolean;
declare function drainSystemEventEntries(sessionKey: string): SystemEvent[];
declare function consumeSystemEventEntries(sessionKey: string, consumedEntries: readonly SystemEvent[]): SystemEvent[];
declare function consumeSelectedSystemEventEntries(sessionKey: string, consumedEntries: readonly SystemEvent[]): SystemEvent[];
declare function drainSystemEvents(sessionKey: string): string[];
/**
 * Remove system events matching a predicate without draining the entire queue.
 * Returns the removed events; non-matching events stay queued.
 */
declare function removeSystemEvents(sessionKey: string, predicate: (event: SystemEvent) => boolean): SystemEvent[];
declare function peekSystemEventEntries(sessionKey: string): SystemEvent[];
declare function peekSystemEvents(sessionKey: string): string[];
declare function hasSystemEvents(sessionKey: string): boolean;
declare function resolveSystemEventDeliveryContext(events: readonly SystemEvent[]): DeliveryContext | undefined;
declare function resetSystemEventsForTest(): void;
//#endregion
export { drainSystemEvents as a, isSystemEventContextChanged as c, removeSystemEvents as d, resetSystemEventsForTest as f, drainSystemEventEntries as i, peekSystemEventEntries as l, consumeSelectedSystemEventEntries as n, enqueueSystemEvent as o, resolveSystemEventDeliveryContext as p, consumeSystemEventEntries as r, hasSystemEvents as s, SystemEvent as t, peekSystemEvents as u };