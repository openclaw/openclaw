import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { t as resolveGlobalMap } from "./global-singleton-Bq6e5lAP.js";
import { a as normalizeDiagnosticTraceparent } from "./diagnostic-trace-context-pure-DT_YEIKj.js";
import "./diagnostic-trace-context-IcGaoHY8.js";
import { n as channelRouteDedupeKey } from "./channel-route-xbmFitKi.js";
import { i as normalizeDeliveryContext, r as mergeDeliveryContext } from "./delivery-context.shared-Cx37tn1U.js";
//#region src/infra/system-events.ts
const MAX_EVENTS = 20;
const queues = resolveGlobalMap(Symbol.for("openclaw.systemEvents.queues"));
function normalizeTraceparent(traceparent) {
	return normalizeDiagnosticTraceparent(traceparent);
}
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
function findDuplicateInQueue(queue, text, contextKey, deliveryContext, trusted) {
	if (contextKey === null) {
		const last = queue[queue.length - 1];
		return last && isDuplicateSystemEvent(last, {
			text,
			contextKey,
			deliveryContext,
			trusted
		}) ? last : void 0;
	}
	for (const event of queue) if (isDuplicateSystemEvent(event, {
		text,
		contextKey,
		deliveryContext,
		trusted
	})) return event;
}
function applyContextKeyPolicy(entry, incomingContextKey) {
	if (incomingContextKey !== null) entry.lastContextKey = incomingContextKey;
}
function enqueueSystemEvent(text, options) {
	const entry = getOrCreateSessionQueue(requireSessionKey(options?.sessionKey));
	const cleaned = text.trim();
	if (!cleaned) return false;
	const normalizedContextKey = normalizeContextKey(options?.contextKey);
	const normalizedDeliveryContext = normalizeDeliveryContext(options?.deliveryContext);
	const trusted = options.trusted !== false;
	if (findDuplicateInQueue(entry.queue, cleaned, normalizedContextKey, normalizedDeliveryContext, trusted)) return false;
	const normalizedTraceparent = normalizeTraceparent(options?.traceparent);
	applyContextKeyPolicy(entry, normalizedContextKey);
	entry.queue.push({
		text: cleaned,
		ts: Date.now(),
		contextKey: normalizedContextKey,
		deliveryContext: normalizedDeliveryContext,
		trusted,
		...normalizedTraceparent ? { traceparent: normalizedTraceparent } : {}
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
	return existing.text === incoming.text && (existing.contextKey ?? null) === (incoming.contextKey ?? null) && (existing.trusted ?? true) === (incoming.trusted ?? true) && areDeliveryContextsEqual(existing.deliveryContext, incoming.deliveryContext);
}
function areSystemEventsEqual(left, right) {
	return left.text === right.text && left.ts === right.ts && (left.contextKey ?? null) === (right.contextKey ?? null) && (left.trusted ?? true) === (right.trusted ?? true) && (left.traceparent ?? void 0) === (right.traceparent ?? void 0) && areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext);
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
/**
* Remove system events matching a predicate without draining the entire queue.
* Returns the removed events; non-matching events stay queued.
*/
function removeSystemEvents(sessionKey, predicate) {
	const key = requireSessionKey(sessionKey);
	const entry = queues.get(key);
	if (!entry || entry.queue.length === 0) return [];
	const removed = [];
	entry.queue = entry.queue.filter((event) => {
		if (predicate(event)) {
			removed.push(event);
			return false;
		}
		return true;
	});
	if (entry.queue.length === 0) queues.delete(key);
	else if (removed.length > 0) entry.lastContextKey = entry.queue[entry.queue.length - 1].contextKey ?? null;
	return removed;
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
export { enqueueSystemEvent as a, peekSystemEventEntries as c, resetSystemEventsForTest as d, resolveSystemEventDeliveryContext as f, drainSystemEvents as i, peekSystemEvents as l, consumeSystemEventEntries as n, hasSystemEvents as o, drainSystemEventEntries as r, isSystemEventContextChanged as s, consumeSelectedSystemEventEntries as t, removeSystemEvents as u };
