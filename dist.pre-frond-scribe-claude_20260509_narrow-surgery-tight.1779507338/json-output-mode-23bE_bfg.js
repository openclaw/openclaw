import { t as loggingState } from "./state-CHRYWIGY.js";
//#region src/cli/json-output-mode.ts
function hasJsonOutputFlag(argv) {
	for (const arg of argv) {
		if (arg === "--") return false;
		if (arg === "--json" || arg.startsWith("--json=")) return true;
	}
	return false;
}
async function withConsoleLogsRoutedToStderrForJson(argv, run) {
	if (!hasJsonOutputFlag(argv)) return run();
	const previousForceStderr = loggingState.forceConsoleToStderr;
	loggingState.forceConsoleToStderr = true;
	try {
		return await run();
	} finally {
		loggingState.forceConsoleToStderr = previousForceStderr;
	}
}
//#endregion
export { withConsoleLogsRoutedToStderrForJson as n, hasJsonOutputFlag as t };
