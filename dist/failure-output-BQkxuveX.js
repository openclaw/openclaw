import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { a as formatUncaughtError, i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
//#region src/cli/failure-output.ts
function hasDebugArg(argv) {
	return Boolean(argv?.some((arg) => arg === "--debug" || arg === "--verbose"));
}
function shouldShowStack(argv, env) {
	return hasDebugArg(argv) || isTruthyEnvValue(env.OPENCLAW_DEBUG);
}
function pushPrefixed(out, value) {
	for (const line of value.split("\n")) if (line.trim().length > 0) out.push(`[openclaw] ${line}`);
}
function formatCliFailureLines(options) {
	const env = options.env ?? process.env;
	const lines = [`[openclaw] ${options.title}`, `[openclaw] Reason: ${formatErrorMessage(options.error)}`];
	if (shouldShowStack(options.argv, env)) {
		lines.push("[openclaw] Stack:");
		pushPrefixed(lines, formatUncaughtError(options.error));
	} else lines.push("[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.");
	if (options.includeDoctorHint !== false) lines.push(`[openclaw] Try: ${formatCliCommand("openclaw doctor", env)}`);
	lines.push(`[openclaw] Help: ${formatCliCommand("openclaw --help", env)}`);
	return lines;
}
//#endregion
export { formatCliFailureLines as t };
