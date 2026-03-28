import { resolveExternalBestEffortDeliveryTarget } from "../infra/outbound/best-effort-delivery.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { callGatewayTool } from "./tools/gateway.js";

type ExecApprovalFollowupParams = {
  approvalId: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  resultText: string;
};

function buildExecDeniedFollowupPrompt(resultText: string): string {
  return [
    "An async command did not run.",
    "Do not run the command again.",
    "There is no new command output.",
    "Do not mention, summarize, or reuse output from any earlier run in this session.",
    "",
    "Exact completion details:",
    resultText.trim(),
    "",
    "Reply to the user in a helpful way.",
    "Explain that the command did not run and why.",
    "Do not claim there is new command output.",
  ].join("\n");
}

export function buildExecApprovalFollowupPrompt(resultText: string): string {
  const trimmed = resultText.trim();
  if (trimmed.startsWith("Exec denied (")) {
    return buildExecDeniedFollowupPrompt(trimmed);
  }
  return [
    "An async command the user already approved has completed.",
    "Do not run the command again.",
    "",
    "Exact completion details:",
    trimmed,
    "",
    "Reply to the user in a helpful way.",
    "If it succeeded, share the relevant output.",
    "If it failed, explain what went wrong.",
  ].join("\n");
}

export async function sendExecApprovalFollowup(
  params: ExecApprovalFollowupParams,
): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  const resultText = params.resultText.trim();
  if (!sessionKey || !resultText) {
    return false;
  }

  const deliveryTarget = resolveExternalBestEffortDeliveryTarget({
    channel: params.turnSourceChannel,
    to: params.turnSourceTo,
    accountId: params.turnSourceAccountId,
    threadId: params.turnSourceThreadId,
  });
  const normalizedTurnSourceChannel = normalizeMessageChannel(params.turnSourceChannel);
  const isInternal = isInternalMessageChannel(normalizedTurnSourceChannel);

  // Webchat (internal channel) has no outbound delivery route — the gateway
  // would try to remap it to a configured external channel and fail.  Skip
  // `deliver` for internal channels and explicitly route the agent run to
  // INTERNAL_MESSAGE_CHANNEL.  For external channels, keep `deliver: true`
  // even when an explicit `to` is missing so the gateway can fall back to
  // session-level implicit routing (last channel / default target).
  const hasExternalDeliveryPair = deliveryTarget.deliver && !isInternal;

  await callGatewayTool(
    "agent",
    { timeoutMs: 60_000 },
    {
      sessionKey,
      message: buildExecApprovalFollowupPrompt(resultText),
      deliver: hasExternalDeliveryPair,
      ...(hasExternalDeliveryPair ? { bestEffortDeliver: true as const } : {}),
      channel: hasExternalDeliveryPair
        ? deliveryTarget.channel
        : isInternal
          ? INTERNAL_MESSAGE_CHANNEL
          : undefined,
      to: hasExternalDeliveryPair ? deliveryTarget.to : undefined,
      accountId: hasExternalDeliveryPair ? deliveryTarget.accountId : undefined,
      threadId: hasExternalDeliveryPair ? deliveryTarget.threadId : undefined,
      idempotencyKey: `exec-approval-followup:${params.approvalId}`,
    },
    { expectFinal: true },
  );

  return true;
}
