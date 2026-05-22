import { c as logToolLoopAction } from "./diagnostic-Dj7arlfF.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-CUB4N-Ww.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-f-Kz-xSY.js";
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
