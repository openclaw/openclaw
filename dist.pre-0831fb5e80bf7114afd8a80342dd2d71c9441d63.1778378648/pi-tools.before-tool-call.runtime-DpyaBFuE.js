import { c as logToolLoopAction } from "./diagnostic-Be67-3Uu.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-M9VzNAdm.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-XSMagWbb.js";
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
