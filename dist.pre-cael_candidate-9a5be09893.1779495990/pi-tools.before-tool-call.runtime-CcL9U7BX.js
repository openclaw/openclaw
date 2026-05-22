import { c as logToolLoopAction } from "./diagnostic-DMXQ0iea.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-BO6_8hHT.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-4uoKJMnh.js";
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
