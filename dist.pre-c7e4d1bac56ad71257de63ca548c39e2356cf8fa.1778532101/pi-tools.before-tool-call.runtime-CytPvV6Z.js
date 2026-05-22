import { c as logToolLoopAction } from "./diagnostic-BDPogzHH.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-CqP9oxoA.js";
import { n as recordToolCall, r as recordToolCallOutcome, t as detectToolCallLoop } from "./tool-loop-detection-sBHl0pV-.js";
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
