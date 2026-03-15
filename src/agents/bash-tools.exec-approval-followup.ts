import {
  type GatewayMessageChannel,
  isDeliverableMessageChannel,
  resolveGatewayMessageChannel,
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

type ExecApprovalFollowupRoute = {
  channel?: GatewayMessageChannel;
  deliver: boolean;
  to?: string;
  accountId?: string;
  threadId?: string;
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

function resolveExecApprovalFollowupRoute(
  params: Pick<
    ExecApprovalFollowupParams,
    "turnSourceChannel" | "turnSourceTo" | "turnSourceAccountId" | "turnSourceThreadId"
  >,
): ExecApprovalFollowupRoute {
  const channel = resolveGatewayMessageChannel(params.turnSourceChannel);
  const to = params.turnSourceTo?.trim() || undefined;
  const threadId =
    params.turnSourceThreadId != null && params.turnSourceThreadId !== ""
      ? String(params.turnSourceThreadId)
      : undefined;

  // Approval follow-ups already have a live agent session to write back to.
  // Only re-enter outbound delivery when we still have a deliverable chat
  // channel and a concrete recipient target from the originating turn.
  if (!channel || !isDeliverableMessageChannel(channel) || !to) {
    return {
      channel,
      deliver: false,
    };
  }

  return {
    channel,
    deliver: true,
    to,
    accountId: params.turnSourceAccountId?.trim() || undefined,
    threadId,
  };
}

export async function sendExecApprovalFollowup(
  params: ExecApprovalFollowupParams,
): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  const resultText = params.resultText.trim();
  if (!sessionKey || !resultText) {
    return false;
  }

  const route = resolveExecApprovalFollowupRoute(params);

  await callGatewayTool(
    "agent",
    { timeoutMs: 60_000 },
    {
      sessionKey,
      message: buildExecApprovalFollowupPrompt(resultText),
      deliver: route.deliver,
      bestEffortDeliver: true,
      channel: route.channel,
      to: route.to,
      accountId: route.accountId,
      threadId: route.threadId,
      idempotencyKey: `exec-approval-followup:${params.approvalId}`,
    },
    { expectFinal: true },
  );

  return true;
}
