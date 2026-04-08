import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { logToolLoopAction } from "../logging/diagnostic.js";
import {
  detectRepeatedUnknownToolCall,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

export const beforeToolCallRuntime = {
  getDiagnosticSessionState,
  logToolLoopAction,
  detectRepeatedUnknownToolCall,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
};
