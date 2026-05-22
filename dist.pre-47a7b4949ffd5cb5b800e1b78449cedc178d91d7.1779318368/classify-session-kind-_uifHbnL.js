import { i as isCronSessionKey } from "./session-key-utils-Ce_xWkNq.js";
//#region src/sessions/classify-session-kind.ts
/**
* Classify a session key + entry into a display kind.
*
* Evaluation order matters — more-specific signals take priority:
*   1. sentinel keys ("global", "unknown")
*   2. cron key shape
*   3. spawn-child (entry has `spawnedBy`) — checked before key-shape so ACP
*      spawn-child sessions with opaque keys are not misclassified as "direct"
*   4. group/channel chatType or key-shape substring
*   5. fallback: "direct"
*/
function classifySessionKind(key, entry) {
	if (key === "global") return "global";
	if (key === "unknown") return "unknown";
	if (isCronSessionKey(key)) return "cron";
	if (entry?.spawnedBy) return "spawn-child";
	if (entry?.chatType === "group" || entry?.chatType === "channel") return "group";
	if (key.includes(":group:") || key.includes(":channel:")) return "group";
	return "direct";
}
//#endregion
export { classifySessionKind as t };
