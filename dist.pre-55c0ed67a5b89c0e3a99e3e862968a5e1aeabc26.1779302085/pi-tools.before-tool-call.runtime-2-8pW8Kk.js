import { c as logToolLoopAction } from "./diagnostic-BMPOwfe6.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-BO6_8hHT.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-C9_Q6X7R.js";
//#region src/agents/pi-tools.before-tool-call.runtime.ts
const beforeToolCallRuntime = {
	getDiagnosticSessionState,
	logToolLoopAction,
	detectToolCallLoop,
	recordToolCall,
	recordToolCallOutcome
};
//#endregion
export { beforeToolCallRuntime };
