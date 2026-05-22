//#region src/agents/pi-embedded-runner/lanes.ts
function resolveSessionLane(key) {
	const cleaned = key.trim() || "main";
	return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}
function resolveGlobalLane(lane) {
	const cleaned = lane?.trim();
	if (cleaned === "cron") return "cron-nested";
	return cleaned ? cleaned : "main";
}
function resolveEmbeddedSessionLane(key) {
	return resolveSessionLane(key);
}
//#endregion
export { resolveGlobalLane as n, resolveSessionLane as r, resolveEmbeddedSessionLane as t };
