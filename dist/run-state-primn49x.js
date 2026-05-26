import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { l as listActiveReplyRunSessionIds, o as getActiveReplyRunCount, u as listActiveReplyRunSessionKeys } from "./reply-run-registry-CwZ9EftF.js";
//#region src/agents/pi-embedded-runner/run-state.ts
const embeddedRunState = resolveGlobalSingleton(Symbol.for("openclaw.embeddedRunState"), () => ({
	activeRuns: /* @__PURE__ */ new Map(),
	snapshots: /* @__PURE__ */ new Map(),
	sessionIdsByKey: /* @__PURE__ */ new Map(),
	waiters: /* @__PURE__ */ new Map(),
	modelSwitchRequests: /* @__PURE__ */ new Map()
}));
const ACTIVE_EMBEDDED_RUNS = embeddedRunState.activeRuns ?? (embeddedRunState.activeRuns = /* @__PURE__ */ new Map());
const ACTIVE_EMBEDDED_RUN_SNAPSHOTS = embeddedRunState.snapshots ?? (embeddedRunState.snapshots = /* @__PURE__ */ new Map());
const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY = embeddedRunState.sessionIdsByKey ?? (embeddedRunState.sessionIdsByKey = /* @__PURE__ */ new Map());
const EMBEDDED_RUN_WAITERS = embeddedRunState.waiters ?? (embeddedRunState.waiters = /* @__PURE__ */ new Map());
const EMBEDDED_RUN_MODEL_SWITCH_REQUESTS = embeddedRunState.modelSwitchRequests ?? (embeddedRunState.modelSwitchRequests = /* @__PURE__ */ new Map());
function getActiveEmbeddedRunCount() {
	let activeCount = ACTIVE_EMBEDDED_RUNS.size;
	for (const sessionId of listActiveReplyRunSessionIds()) if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) activeCount += 1;
	return Math.max(activeCount, getActiveReplyRunCount());
}
function listActiveEmbeddedRunSessionKeys() {
	return [...new Set([...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.keys(), ...listActiveReplyRunSessionKeys()])].toSorted((a, b) => a.localeCompare(b));
}
function listActiveEmbeddedRunSessionIds() {
	return [...new Set([
		...ACTIVE_EMBEDDED_RUNS.keys(),
		...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.values(),
		...listActiveReplyRunSessionIds()
	])].toSorted((a, b) => a.localeCompare(b));
}
//#endregion
export { EMBEDDED_RUN_WAITERS as a, listActiveEmbeddedRunSessionKeys as c, EMBEDDED_RUN_MODEL_SWITCH_REQUESTS as i, ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY as n, getActiveEmbeddedRunCount as o, ACTIVE_EMBEDDED_RUN_SNAPSHOTS as r, listActiveEmbeddedRunSessionIds as s, ACTIVE_EMBEDDED_RUNS as t };
