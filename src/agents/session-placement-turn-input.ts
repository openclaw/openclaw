import type { RunEmbeddedAgentParamsWithSessionFile } from "./embedded-agent-runner/run/internal-params.js";

/** Bind caller-local execution to the admitted turn's authority and prepared input. */
export async function withSessionPlacementTurnInput<T>(
  caller: RunEmbeddedAgentParamsWithSessionFile,
  admitted: RunEmbeddedAgentParamsWithSessionFile,
  run: () => Promise<T>,
): Promise<T> {
  const hadAbortSignal = Object.hasOwn(caller, "abortSignal");
  const callerAbortSignal = caller.abortSignal;
  const hadReplyOperation = Object.hasOwn(caller, "replyOperation");
  const callerReplyOperation = caller.replyOperation;
  const callerPrompt = caller.prompt;
  const callerTranscriptPrompt = caller.transcriptPrompt;
  const callerSessionTarget = caller.sessionTarget;
  caller.replyOperation = admitted.replyOperation;
  caller.abortSignal = admitted.abortSignal;
  caller.prompt = admitted.prompt;
  caller.transcriptPrompt = admitted.transcriptPrompt;
  caller.sessionTarget = admitted.sessionTarget;
  try {
    return await run();
  } finally {
    caller.prompt = callerPrompt;
    caller.transcriptPrompt = callerTranscriptPrompt;
    caller.sessionTarget = callerSessionTarget;
    if (hadReplyOperation) {
      caller.replyOperation = callerReplyOperation;
    } else {
      delete caller.replyOperation;
    }
    if (hadAbortSignal) {
      caller.abortSignal = callerAbortSignal;
    } else {
      delete caller.abortSignal;
    }
  }
}
