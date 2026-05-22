import { t as listSystemPresence } from "./system-presence-Cj1j_O4u.js";
//#region src/gateway/server-methods/nodes-wake-state.ts
const NODE_WAKE_RECONNECT_WAIT_MS = 3e3;
const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12e3;
const nodeWakeById = /* @__PURE__ */ new Map();
const nodeWakeNudgeById = /* @__PURE__ */ new Map();
function clearNodeWakeState(nodeId) {
	nodeWakeById.delete(nodeId);
	nodeWakeNudgeById.delete(nodeId);
}
//#endregion
//#region src/gateway/server/presence-events.ts
function broadcastPresenceSnapshot(params) {
	const presenceVersion = params.incrementPresenceVersion();
	params.broadcast("presence", { presence: listSystemPresence() }, {
		dropIfSlow: true,
		stateVersion: {
			presence: presenceVersion,
			health: params.getHealthVersion()
		}
	});
	return presenceVersion;
}
//#endregion
export { nodeWakeById as a, clearNodeWakeState as i, NODE_WAKE_RECONNECT_RETRY_WAIT_MS as n, nodeWakeNudgeById as o, NODE_WAKE_RECONNECT_WAIT_MS as r, broadcastPresenceSnapshot as t };
