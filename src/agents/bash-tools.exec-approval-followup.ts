import { INTERNAL_MESSAGE_CHANNEL, isInternalMessageChannel } from "../utils/message-channel.js";
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

export function buildExecApprovalFollowupPrompt(resultText: string): string {
  return [
    "An async command the user already approved has completed.",
    "Do not run the command again.",
    "",
    "Exact completion details:",
    resultText.trim(),
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

  const channel = params.turnSourceChannel?.trim();
  const to = params.turnSourceTo?.trim();
  const threadId =
    params.turnSourceThreadId != null && params.turnSourceThreadId !== ""
      ? String(params.turnSourceThreadId)
      : undefined;

  // Outbound `deliver` targets external messaging plugins. Webchat (Control UI) has no
  // deliverable route and no `to`; `deliver: true` would make the gateway try to remap
  // webchat to a configured channel and fail when none exist (e.g. Docker-only gateway).
  const hasExternalDeliveryPair = Boolean(channel && to) && !isInternalMessageChannel(channel);
  const deliver = hasExternalDeliveryPair;
  const explicitChannel =
    channel && to
      ? channel
      : isInternalMessageChannel(channel)
        ? INTERNAL_MESSAGE_CHANNEL
        : undefined;

  await callGatewayTool(
    "agent",
    { timeoutMs: 60_000 },
    {
      sessionKey,
      message: buildExecApprovalFollowupPrompt(resultText),
      deliver,
      bestEffortDeliver: true,
      channel: explicitChannel,
      to: channel && to ? to : undefined,
      accountId: channel && to ? params.turnSourceAccountId?.trim() || undefined : undefined,
      threadId: channel && to ? threadId : undefined,
      idempotencyKey: `exec-approval-followup:${params.approvalId}`,
    },
    { expectFinal: true },
  );

  return true;
}
