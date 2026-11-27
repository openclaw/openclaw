import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import {
  resolveDirectAnnounceResponse,
  type AnnounceResponseDecision,
  type DirectAnnounceResponseContext,
} from "./subagent-announce-obligation.js";

type TextCompletionTransport = (agentResult?: {
  payloads?: unknown;
}) => Promise<SubagentAnnounceDeliveryResult | undefined>;

/** Execute only the fallback selected by the completion obligation. */
export async function executeAnnounceResponseDecision(
  decision: AnnounceResponseDecision,
  sendText: TextCompletionTransport,
): Promise<SubagentAnnounceDeliveryResult> {
  let next = decision;
  while ("action" in next) {
    const delivery = await sendText(next.agentResult);
    if (delivery) {
      return delivery;
    }
    next = next.unavailable;
  }
  return next;
}

export function createDirectAnnounceResponseClassifier(
  context: DirectAnnounceResponseContext & {
    tryTextCompletionDirectDelivery: TextCompletionTransport;
  },
) {
  return (response: unknown) =>
    executeAnnounceResponseDecision(
      resolveDirectAnnounceResponse(context, response),
      context.tryTextCompletionDirectDelivery,
    );
}
