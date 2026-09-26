import {
  captureHistoryReadScope,
  usesProcessHeldTranscript,
  visitSessionMessagesAsync,
  type SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";
import {
  readMainSessionRecoveryCheckpointFromReader,
  type MainSessionRecoveryCheckpoint,
} from "./main-session-restart-recovery-checkpoint-reader.js";

export async function readMainSessionRecoveryCheckpoint(
  scope: SessionTranscriptReadScope,
): Promise<MainSessionRecoveryCheckpoint> {
  const target = captureHistoryReadScope(scope);
  if (usesProcessHeldTranscript(target)) {
    return readMainSessionRecoveryCheckpointFromReader(target, { visitSessionMessagesAsync });
  }
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({ kind: "recovery-checkpoint", params: { target } });
}
