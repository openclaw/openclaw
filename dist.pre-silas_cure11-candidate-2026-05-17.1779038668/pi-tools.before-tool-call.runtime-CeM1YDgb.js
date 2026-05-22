import { c as logToolLoopAction } from "./diagnostic-CtRNdYJs.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-DSMO_yiE.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-D5x22fT8.js";
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
