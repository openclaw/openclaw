import { f as logToolLoopAction } from "./diagnostic-DEgTYLXt.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-BO6_8hHT.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-8mMHShpN.js";
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
