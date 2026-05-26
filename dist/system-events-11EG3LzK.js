import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as resolveGlobalMap } from "./global-singleton-DE6St75u.js";
import { n as channelRouteDedupeKey } from "./channel-route-L2PJ-xNE.js";
import { i as mergeDeliveryContext, o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
//#region src/infra/system-events.ts
const MAX_EVENTS = 20;
const queues = resolveGlobalMap(Symbol.for("openclaw.systemEvents.queues"));
function requireSessionKey(key) {
	const trimmed = normalizeOptionalString(key) ?? "";
	if (!trimmed) throw new Error("system events require a sessionKey");
	return trimmed;
}
function normalizeContextKey(key) {
	return normalizeOptionalLowercaseString(key) ?? null;
}
function getSessionQueue(sessionKey) {
	return queues.get(requireSessionKey(sessionKey));
}
function getOrCreateSessionQueue(sessionKey) {
	const key = requireSessionKey(sessionKey);
	const existing = queues.get(key);
	if (existing) return existing;
	const created = {
		queue: [],
		lastContextKey: null
	};
	queues.set(key, created);
	return created;
}
function cloneSystemEvent(event) {
	return {
		...event,
		...event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}
	};
}
function isSystemEventContextChanged(sessionKey, contextKey) {
	const existing = getSessionQueue(sessionKey);
	return normalizeContextKey(contextKey) !== (existing?.lastContextKey ?? null);
}
function findDuplicateInQueue(queue, text, contextKey, deliveryContext) {
	const incoming = {
		text,
		contextKey,
		deliveryContext
	};
	if (contextKey === null) {
		const last = queue[queue.length - 1];
		return last ? isDuplicateSystemEvent(last, incoming) : false;
	}
	return queue.some((event) => isDuplicateSystemEvent(event, incoming));
}
function enqueueSystemEvent(text, options) {
	const entry = getOrCreateSessionQueue(requireSessionKey(options.sessionKey));
	const cleaned = text.trim();
	if (!cleaned) return false;
	const normalizedContextKey = normalizeContextKey(options.contextKey);
	const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
	if (findDuplicateInQueue(entry.queue, cleaned, normalizedContextKey, normalizedDeliveryContext)) return false;
	if (normalizedContextKey !== null) entry.lastContextKey = normalizedContextKey;
	entry.queue.push({
		text: cleaned,
		ts: Date.now(),
		contextKey: normalizedContextKey,
		deliveryContext: normalizedDeliveryContext
	});
	if (entry.queue.length > MAX_EVENTS) entry.queue.shift();
	return true;
}
function drainSystemEventEntries(sessionKey) {
	const key = requireSessionKey(sessionKey);
	const entry = getSessionQueue(key);
	if (!entry || entry.queue.length === 0) return [];
	const out = entry.queue.map(cloneSystemEvent);
	entry.queue.length = 0;
	entry.lastContextKey = null;
	queues.delete(key);
	return out;
}
function areDeliveryContextsEqual(left, right) {
	if (!left && !right) return true;
	if (!left || !right) return false;
	return channelRouteDedupeKey(left) === channelRouteDedupeKey(right);
}
function isDuplicateSystemEvent(existing, incoming) {
	return existing.text === incoming.text && (existing.contextKey ?? null) === (incoming.contextKey ?? null) && areDeliveryContextsEqual(existing.deliveryContext, incoming.deliveryContext);
}
function areSystemEventsEqual(left, right) {
	return left.text === right.text && left.ts === right.ts && (left.contextKey ?? null) === (right.contextKey ?? null) && areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext);
}
function resetQueueState(key, entry) {
	if (entry.queue.length === 0) {
		entry.lastContextKey = null;
		queues.delete(key);
		return;
	}
	for (let index = entry.queue.length - 1; index >= 0; index -= 1) {
		const contextKey = entry.queue[index].contextKey ?? null;
		if (contextKey !== null) {
			entry.lastContextKey = contextKey;
			return;
		}
	}
	entry.lastContextKey = null;
}
function consumeSystemEventEntries(sessionKey, consumedEntries) {
	const key = requireSessionKey(sessionKey);
	const entry = getSessionQueue(key);
	if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) return [];
	if (consumedEntries.length > entry.queue.length || !consumedEntries.every((event, index) => areSystemEventsEqual(entry.queue[index], event))) return [];
	const removed = entry.queue.splice(0, consumedEntries.length).map(cloneSystemEvent);
	resetQueueState(key, entry);
	return removed;
}
function consumeSelectedSystemEventEntries(sessionKey, consumedEntries) {
	const key = requireSessionKey(sessionKey);
	const entry = getSessionQueue(key);
	if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) return [];
	const removed = [];
	for (const consumed of consumedEntries) {
		const index = entry.queue.findIndex((event) => areSystemEventsEqual(event, consumed));
		if (index === -1) continue;
		const [event] = entry.queue.splice(index, 1);
		if (event) removed.push(cloneSystemEvent(event));
	}
	resetQueueState(key, entry);
	return removed;
}
function drainSystemEvents(sessionKey) {
	return drainSystemEventEntries(sessionKey).map((event) => event.text);
}
function peekSystemEventEntries(sessionKey) {
	return getSessionQueue(sessionKey)?.queue.map(cloneSystemEvent) ?? [];
}
function peekSystemEvents(sessionKey) {
	return peekSystemEventEntries(sessionKey).map((event) => event.text);
}
function hasSystemEvents(sessionKey) {
	return (getSessionQueue(sessionKey)?.queue.length ?? 0) > 0;
}
function resolveSystemEventDeliveryContext(events) {
	let resolved;
	for (const event of events) resolved = mergeDeliveryContext(event.deliveryContext, resolved);
	return resolved;
}
function resetSystemEventsForTest() {
	queues.clear();
}
//#endregion
export { enqueueSystemEvent as a, peekSystemEventEntries as c, resolveSystemEventDeliveryContext as d, drainSystemEvents as i, peekSystemEvents as l, consumeSystemEventEntries as n, hasSystemEvents as o, drainSystemEventEntries as r, isSystemEventContextChanged as s, consumeSelectedSystemEventEntries as t, resetSystemEventsForTest as u };
