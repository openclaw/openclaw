import { c as logToolLoopAction } from "./diagnostic-BRguDftA.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-BFBOkgJ_.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-8Dpg8ani.js";
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
