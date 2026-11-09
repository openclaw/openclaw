import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

/**
 * A fork succeeded only when the model and runtime finished without error. Tool errors the model
 * saw and recovered from (warning payloads) do not fail the fork.
 */
export function assertSessionForkRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): void {
  const runtimeErrorPayload = result.payloads?.find(
    (payload) => payload.isError && !getReplyPayloadMetadata(payload)?.toolErrorWarning,
  );
  const message =
    result.meta.error?.message.trim() ||
    (result.meta.aborted ? "Session fork model run aborted." : undefined) ||
    runtimeErrorPayload?.text?.trim();
  if (message || runtimeErrorPayload) {
    throw new Error(message || "Session fork model run failed.");
  }
}
