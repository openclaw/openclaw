//#region src/security/dangerous-tools.ts
/**
* Tools denied via Gateway HTTP `POST /tools/invoke` by default.
* These are high-risk because they enable session orchestration, control-plane actions,
* or interactive flows that don't make sense over a non-interactive HTTP surface.
*/
const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
	"sessions_spawn",
	"sessions_send",
	"cron",
	"gateway",
	"whatsapp_login"
];
/**
* ACP tools that should always require explicit user approval.
* ACP is an automation surface; we never want "silent yes" for mutating/execution tools.
*/
const DANGEROUS_ACP_TOOL_NAMES = [
	"exec",
	"spawn",
	"shell",
	"sessions_spawn",
	"sessions_send",
	"gateway",
	"fs_write",
	"fs_delete",
	"fs_move",
	"apply_patch"
];
const DANGEROUS_ACP_TOOLS = new Set(DANGEROUS_ACP_TOOL_NAMES);

//#endregion
export { DEFAULT_GATEWAY_HTTP_TOOL_DENY as n, DANGEROUS_ACP_TOOLS as t };