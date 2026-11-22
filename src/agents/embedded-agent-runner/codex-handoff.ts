import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../agent-runtime-id.js";
import { AgentHarnessPreflightError, recordAgentHarnessPreflightOwner } from "../harness/errors.js";

export class EmbeddedCodexHandoffError extends AgentHarnessPreflightError {
  constructor() {
    const message =
      "This Codex conversation has no portable compaction summary. Continue in Codex or start a fresh session to use this runtime.";
    super(message, { userMessage: message, scope: "harness" });
    recordAgentHarnessPreflightOwner(this, OPENCLAW_AGENT_RUNTIME_ID);
  }
}

/** A handoff refusal skips maintenance, not unrelated runtime candidates. */
export function deferEmbeddedCodexHandoff<T>(source: T): (error: unknown) => T {
  return (error) => {
    if (error instanceof EmbeddedCodexHandoffError) {
      return source;
    }
    throw error;
  };
}

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
    throw new EmbeddedCodexHandoffError();
  }
}
