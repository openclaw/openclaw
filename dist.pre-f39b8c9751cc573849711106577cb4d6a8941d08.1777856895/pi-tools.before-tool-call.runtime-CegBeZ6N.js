import { c as logToolLoopAction } from "./diagnostic-5w-8kHIX.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-CDSzyS3q.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-ATi3NpbD.js";
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
