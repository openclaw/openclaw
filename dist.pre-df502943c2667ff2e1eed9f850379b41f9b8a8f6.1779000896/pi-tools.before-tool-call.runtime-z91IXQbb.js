import { c as logToolLoopAction } from "./diagnostic-C0jcyWM1.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-CyhsYPdX.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-C-py4FTX.js";
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
