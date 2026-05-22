import { c as logToolLoopAction } from "./diagnostic-3MOa2HgV.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-CdQnjFWv.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-D-aEat27.js";
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
