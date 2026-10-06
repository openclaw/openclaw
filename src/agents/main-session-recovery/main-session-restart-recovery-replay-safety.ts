import {
  readSessionTranscriptSummaryAsync,
  type SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";

export async function readMainSessionRecoveryCheckpoint(scope: SessionTranscriptReadScope) {
  const { checkpoint } = await readSessionTranscriptSummaryAsync(scope, {
    kind: "recovery-checkpoint",
  });
  return checkpoint;
}
