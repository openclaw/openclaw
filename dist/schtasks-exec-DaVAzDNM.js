import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
//#region src/daemon/schtasks-exec.ts
const SCHTASKS_TIMEOUT_MS = 15e3;
const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 3e4;
async function execSchtasks(args) {
	const result = await runCommandWithTimeout(["schtasks", ...args], {
		timeoutMs: SCHTASKS_TIMEOUT_MS,
		noOutputTimeoutMs: SCHTASKS_NO_OUTPUT_TIMEOUT_MS
	});
	const timeoutDetail = result.termination === "timeout" ? `schtasks timed out after ${SCHTASKS_TIMEOUT_MS}ms` : result.termination === "no-output-timeout" ? `schtasks produced no output for ${SCHTASKS_NO_OUTPUT_TIMEOUT_MS}ms` : "";
	return {
		stdout: result.stdout,
		stderr: result.stderr || timeoutDetail,
		code: typeof result.code === "number" ? result.code : result.killed ? 124 : 1
	};
}
//#endregion
export { execSchtasks as t };
