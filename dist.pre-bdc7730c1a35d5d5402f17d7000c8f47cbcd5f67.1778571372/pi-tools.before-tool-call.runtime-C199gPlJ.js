import { c as logToolLoopAction } from "./diagnostic-Cn106zlM.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-BWYs5a98.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-B-QK-MqU.js";
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
