import { n as resolveGlobalSingleton } from "./global-singleton-DZyLAEQq.js";
import { n as registerListener, t as notifyListeners } from "./listeners-CIyaoVUu.js";
//#region src/infra/heartbeat-events.ts
function resolveIndicatorType(status) {
	switch (status) {
		case "ok-empty":
		case "ok-token": return "ok";
		case "sent": return "alert";
		case "failed": return "error";
		case "skipped": return;
	}
	throw new Error("Unsupported heartbeat status");
}
const state = resolveGlobalSingleton(Symbol.for("openclaw.heartbeatEvents.state"), () => ({
	lastHeartbeat: null,
	listeners: /* @__PURE__ */ new Set()
}));
function emitHeartbeatEvent(evt) {
	const enriched = {
		ts: Date.now(),
		...evt
	};
	state.lastHeartbeat = enriched;
	notifyListeners(state.listeners, enriched);
}
function onHeartbeatEvent(listener) {
	return registerListener(state.listeners, listener);
}
function getLastHeartbeatEvent() {
	return state.lastHeartbeat;
}
function resetHeartbeatEventsForTest() {
	state.lastHeartbeat = null;
	state.listeners.clear();
}
//#endregion
export { resolveIndicatorType as a, resetHeartbeatEventsForTest as i, getLastHeartbeatEvent as n, onHeartbeatEvent as r, emitHeartbeatEvent as t };
