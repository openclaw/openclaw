import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
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

  const normalizedChannel = normalizeMessageChannel(params.turnSourceChannel);
  const channel =
    normalizedChannel && isDeliverableMessageChannel(normalizedChannel)
      ? normalizedChannel
      : undefined;
  const to = params.turnSourceTo?.trim();
  const hasDeliveryTarget = Boolean(channel && to);
  const threadId =
    params.turnSourceThreadId != null && params.turnSourceThreadId !== ""
      ? String(params.turnSourceThreadId)
      : undefined;

  await callGatewayTool(
    "agent",
    { timeoutMs: 60_000 },
    {
      sessionKey,
      message: buildExecApprovalFollowupPrompt(resultText),
      deliver: hasDeliveryTarget,
      ...(hasDeliveryTarget ? { bestEffortDeliver: true as const } : {}),
      channel: hasDeliveryTarget ? channel : undefined,
      to: hasDeliveryTarget ? to : undefined,
      accountId: hasDeliveryTarget ? params.turnSourceAccountId?.trim() || undefined : undefined,
      threadId: hasDeliveryTarget ? threadId : undefined,
      idempotencyKey: `exec-approval-followup:${params.approvalId}`,
    },
    { expectFinal: true },
  );

  return true;
}
