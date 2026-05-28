//#region packages/gateway-protocol/src/client-info.ts
function normalizeOptionalLowercaseString(raw) {
	if (typeof raw !== "string") return;
	return raw.trim().toLowerCase() || void 0;
}
const GATEWAY_CLIENT_IDS = {
	WEBCHAT_UI: "webchat-ui",
	CONTROL_UI: "openclaw-control-ui",
	TUI: "openclaw-tui",
	WEBCHAT: "webchat",
	CLI: "cli",
	GATEWAY_CLIENT: "gateway-client",
	MACOS_APP: "openclaw-macos",
	IOS_APP: "openclaw-ios",
	ANDROID_APP: "openclaw-android",
	NODE_HOST: "node-host",
	TEST: "test",
	FINGERPRINT: "fingerprint",
	PROBE: "openclaw-probe"
};
const GATEWAY_CLIENT_NAMES = GATEWAY_CLIENT_IDS;
const GATEWAY_CLIENT_MODES = {
	WEBCHAT: "webchat",
	CLI: "cli",
	UI: "ui",
	BACKEND: "backend",
	NODE: "node",
	PROBE: "probe",
	TEST: "test"
};
const GATEWAY_CLIENT_CAPS = { TOOL_EVENTS: "tool-events" };
const GATEWAY_CLIENT_ID_SET = new Set(Object.values(GATEWAY_CLIENT_IDS));
const GATEWAY_CLIENT_MODE_SET = new Set(Object.values(GATEWAY_CLIENT_MODES));
function normalizeGatewayClientId(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (!normalized) return;
	return GATEWAY_CLIENT_ID_SET.has(normalized) ? normalized : void 0;
}
function normalizeGatewayClientName(raw) {
	return normalizeGatewayClientId(raw);
}
function normalizeGatewayClientMode(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (!normalized) return;
	return GATEWAY_CLIENT_MODE_SET.has(normalized) ? normalized : void 0;
}
function hasGatewayClientCap(caps, cap) {
	if (!Array.isArray(caps)) return false;
	return caps.includes(cap);
}
//#endregion
export { GATEWAY_CLIENT_CAPS, GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, hasGatewayClientCap, normalizeGatewayClientId, normalizeGatewayClientMode, normalizeGatewayClientName };
