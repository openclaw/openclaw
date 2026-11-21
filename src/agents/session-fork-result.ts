import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

/**
 * A fork succeeded only when the model and runtime finished without error. Tool errors the model
 * saw and recovered from (warning payloads) do not fail the fork.
 */
export function assertSessionForkRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
  assertSourceCurrent?: () => void,
  readSourceFailure?: () => Error | undefined,
): void {
  const runtimeErrorPayload = result.payloads?.find(
    (payload) => payload.isError && !getReplyPayloadMetadata(payload)?.toolErrorWarning,
  );
  const message =
    result.meta.error?.message.trim() ||
    (result.meta.aborted ? "Session fork model run aborted." : undefined) ||
    runtimeErrorPayload?.text?.trim();
  if (message || runtimeErrorPayload) {
    // The embedded result carries only bounded text. Reassert the source before replacing its
    // typed fence diagnostic with the generic terminal message.
    const sourceFailure = readSourceFailure?.();
    if (sourceFailure !== undefined) {
      throw sourceFailure;
    }
    assertSourceCurrent?.();
    throw new Error(message || "Session fork model run failed.");
  }
}
