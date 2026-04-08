import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { logToolLoopAction } from "../logging/diagnostic.js";
import {
  detectToolCallLoop,
  detectUnknownToolLoop,
  isUnknownToolErrorText,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

export const beforeToolCallRuntime = {
  getDiagnosticSessionState,
  logToolLoopAction,
  detectToolCallLoop,
  detectUnknownToolLoop,
  isUnknownToolErrorText,
  recordToolCall,
  recordToolCallOutcome,
};
