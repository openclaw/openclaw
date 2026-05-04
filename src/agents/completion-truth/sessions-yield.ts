import type { CompletionWorkerOutput } from "./types.js";

export type SessionsYieldCompletionOutput = Omit<CompletionWorkerOutput, "source" | "status"> & {
  source: "sessions_yield";
  status: "yielded";
  message: string;
  sessionId: string;
  toolCallId: string;
};

export function buildSessionsYieldCompletionOutput(params: {
  message: string;
  sessionId: string;
  toolCallId: string;
}): SessionsYieldCompletionOutput {
  return {
    source: "sessions_yield",
    status: "yielded",
    message: params.message,
    sessionId: params.sessionId,
    toolCallId: params.toolCallId,
  };
}
