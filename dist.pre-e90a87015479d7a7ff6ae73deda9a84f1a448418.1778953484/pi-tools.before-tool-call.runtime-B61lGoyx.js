import { c as logToolLoopAction } from "./diagnostic-BI8QBZeI.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-o3TJjJli.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-DF0lZYZ1.js";
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
