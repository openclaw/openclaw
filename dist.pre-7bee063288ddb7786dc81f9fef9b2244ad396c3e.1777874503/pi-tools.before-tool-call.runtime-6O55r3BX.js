import { c as logToolLoopAction } from "./diagnostic-OnLcowA0.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-Dq0ZJI3F.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-DZvfwurA.js";
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
