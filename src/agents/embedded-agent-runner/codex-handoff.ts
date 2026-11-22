import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { AgentHarnessPreflightError } from "../harness/errors.js";

export async function assertEmbeddedCodexHandoff(
  target: SessionTranscriptRuntimeTarget,
  assertCurrent: () => void,
): Promise<void> {
  const { readSessionTranscriptModelContextInWorker } =
    await import("../../config/sessions/session-transcript-read-worker-runtime.js");
  assertCurrent();
  const { uncoveredCodexCompaction } = await readSessionTranscriptModelContextInWorker(
    target,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  assertCurrent();
  if (uncoveredCodexCompaction) {
    const message =
      "This Codex conversation has no portable compaction summary. Continue in Codex or start a fresh session to use this runtime.";
    throw new AgentHarnessPreflightError(message, { userMessage: message });
  }
}
