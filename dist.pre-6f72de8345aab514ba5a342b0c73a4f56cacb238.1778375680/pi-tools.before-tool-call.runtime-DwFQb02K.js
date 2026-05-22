import { c as logToolLoopAction } from "./diagnostic-Cw0ETe6T.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-O3-bncD8.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-Depgm0fn.js";
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
