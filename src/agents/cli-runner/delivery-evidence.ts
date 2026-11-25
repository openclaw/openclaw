/**
 * Carries confirmed CLI messaging delivery across failed execution/finalization paths.
 */
import type { CliOutput } from "../cli-output-contracts.js";

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

const deliveryEvidence = new WeakMap<object, CliMessagingDeliveryEvidence>();

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
  const failure =
    error && typeof error === "object" ? error : new Error(String(error), { cause: error });
  deliveryEvidence.set(failure, evidence);
  return failure;
}

/** Reads confirmed delivery evidence from a failed CLI attempt. */
export function getCliMessagingDeliveryEvidence(
  error: unknown,
): CliMessagingDeliveryEvidence | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return deliveryEvidence.get(error);
}
