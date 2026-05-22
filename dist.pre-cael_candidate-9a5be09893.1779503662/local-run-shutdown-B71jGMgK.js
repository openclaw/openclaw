//#region src/tui/local-run-shutdown.ts
const LOCAL_RUN_SHUTDOWN_GRACE_MS = 12e4;
function resolveLocalRunShutdownGraceMs() {
	const raw = process.env.OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS?.trim();
	const parsed = raw ? Number.parseInt(raw, 10) : NaN;
	if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	return LOCAL_RUN_SHUTDOWN_GRACE_MS;
}
//#endregion
export { resolveLocalRunShutdownGraceMs as t };
