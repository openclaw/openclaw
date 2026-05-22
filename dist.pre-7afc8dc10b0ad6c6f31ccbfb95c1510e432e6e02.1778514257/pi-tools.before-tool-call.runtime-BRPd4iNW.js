import { c as logToolLoopAction } from "./diagnostic-CkLscAbT.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-oIOH9qX-.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-BVf4j-09.js";
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
