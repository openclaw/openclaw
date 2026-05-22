import { c as logToolLoopAction } from "./diagnostic-Dg2TYKl8.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-CaS7Cm25.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-g1-rWTlp.js";
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
