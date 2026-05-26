import { t as DeliveryContext } from "./delivery-context.types-DsJXWtUi.js";

//#region src/infra/system-events.d.ts
type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
};
type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
};
declare function isSystemEventContextChanged(sessionKey: string, contextKey?: string | null): boolean;
declare function enqueueSystemEvent(text: string, options: SystemEventOptions): boolean;
declare function drainSystemEventEntries(sessionKey: string): SystemEvent[];
declare function consumeSystemEventEntries(sessionKey: string, consumedEntries: readonly SystemEvent[]): SystemEvent[];
declare function consumeSelectedSystemEventEntries(sessionKey: string, consumedEntries: readonly SystemEvent[]): SystemEvent[];
declare function drainSystemEvents(sessionKey: string): string[];
declare function peekSystemEventEntries(sessionKey: string): SystemEvent[];
declare function peekSystemEvents(sessionKey: string): string[];
declare function hasSystemEvents(sessionKey: string): boolean;
declare function resolveSystemEventDeliveryContext(events: readonly SystemEvent[]): DeliveryContext | undefined;
declare function resetSystemEventsForTest(): void;
//#endregion
export { drainSystemEvents as a, isSystemEventContextChanged as c, resetSystemEventsForTest as d, resolveSystemEventDeliveryContext as f, drainSystemEventEntries as i, peekSystemEventEntries as l, consumeSelectedSystemEventEntries as n, enqueueSystemEvent as o, consumeSystemEventEntries as r, hasSystemEvents as s, SystemEvent as t, peekSystemEvents as u };