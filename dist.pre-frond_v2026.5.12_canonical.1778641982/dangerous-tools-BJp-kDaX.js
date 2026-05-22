//#region src/security/dangerous-tools.ts
/**
* Tools denied via Gateway HTTP `POST /tools/invoke` by default.
* These are high-risk because they enable session orchestration, control-plane actions,
* or interactive flows that don't make sense over a non-interactive HTTP surface.
*/
const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
	"exec",
	"spawn",
	"shell",
	"fs_write",
	"fs_delete",
	"fs_move",
	"apply_patch",
	"sessions_spawn",
	"sessions_send",
	"cron",
	"gateway",
	"nodes"
];
//#endregion
export { DEFAULT_GATEWAY_HTTP_TOOL_DENY as t };
