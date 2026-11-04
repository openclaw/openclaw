import {
  captureIncognitoMemoryReader,
  readRestoredSessionTranscript,
  readSessionResetRecallCutoffInWorker,
  SessionTranscriptColdError,
} from "./openclaw-runtime-session.js";
import type { SessionResetRecallScope } from "./session-reset-recall-read.worker.js";
import type { SessionResetRecallCutoff } from "./session-reset-recall.js";

export async function readSessionResetRecallCutoff(
  scope: SessionResetRecallScope,
): Promise<SessionResetRecallCutoff> {
  const source = captureIncognitoMemoryReader(scope);
  if (source) {
    return source.memoryResetRecall();
  }
  const read = () => readSessionResetRecallCutoffInWorker(scope);
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError) || error.sessionId !== scope.sessionId) {
      throw error;
    }
    return readRestoredSessionTranscript(scope, read);
  }
}
