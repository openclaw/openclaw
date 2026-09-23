/**
 * Carries confirmed CLI messaging delivery across failed execution/finalization paths.
 */
import type { CliOutput } from "../cli-output-contracts.js";

const CLI_MESSAGING_DELIVERY_EVIDENCE_KEY = "cliMessagingDeliveryEvidence";

type CliMessagingDeliveryEvidence = Pick<
  CliOutput,
  | "didSendViaMessagingTool"
  | "didDeliverSourceReplyViaMessageTool"
  | "sourceReplyDelivered"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "messagingToolSourceReplyPayloads"
>;

export function projectCliMessagingDeliveryEvidence(
  output: CliMessagingDeliveryEvidence,
  snapshot = false,
): CliMessagingDeliveryEvidence {
  const evidence: CliMessagingDeliveryEvidence = {};
  for (const key of [
    "didSendViaMessagingTool",
    "didDeliverSourceReplyViaMessageTool",
    "sourceReplyDelivered",
  ] as const) {
    if (output[key]) {
      evidence[key] = true;
    }
  }
  for (const key of [
    "messagingToolSentTexts",
    "messagingToolSentMediaUrls",
    "messagingToolSentTargets",
    "messagingToolSourceReplyPayloads",
  ] as const) {
    const values = output[key];
    if (values?.length) {
      Object.assign(evidence, { [key]: snapshot ? values.slice() : values });
    }
  }
  return evidence;
}

function snapshotCliMessagingDeliveryEvidence(
  output: CliMessagingDeliveryEvidence,
): CliMessagingDeliveryEvidence | undefined {
  return output.didSendViaMessagingTool === true
    ? projectCliMessagingDeliveryEvidence(output, true)
    : undefined;
}

/** Attaches confirmed delivery evidence so caller retries cannot duplicate a visible send. */
export function attachCliMessagingDeliveryEvidence(
  error: unknown,
  output: CliMessagingDeliveryEvidence,
): unknown {
  const evidence = snapshotCliMessagingDeliveryEvidence(output);
  if (!evidence) {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      Object.assign(error, { [CLI_MESSAGING_DELIVERY_EVIDENCE_KEY]: evidence });
      return error;
    } catch {
      // Frozen and non-extensible failures need a mutable wrapper.
    }
  }
  const wrapped = new Error(error instanceof Error ? error.message : String(error), {
    cause: error,
  });
  Object.assign(wrapped, { [CLI_MESSAGING_DELIVERY_EVIDENCE_KEY]: evidence });
  return wrapped;
}

/** Reads confirmed delivery evidence from a failed CLI attempt. */
export function getCliMessagingDeliveryEvidence(
  error: unknown,
): CliMessagingDeliveryEvidence | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const evidence = (error as Record<string, unknown>)[CLI_MESSAGING_DELIVERY_EVIDENCE_KEY];
  return evidence && typeof evidence === "object"
    ? snapshotCliMessagingDeliveryEvidence(evidence as CliMessagingDeliveryEvidence)
    : undefined;
}
