import { c as logToolLoopAction } from "./diagnostic-FvvsVS2u.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-RCN6zYT9.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-FoyZ7Jjj.js";
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
