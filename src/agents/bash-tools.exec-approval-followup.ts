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

  // Only request external delivery when there is an explicit channel+to
  // target.  When the turn originated from webchat (no external target),
  // setting deliver=false avoids the "Channel is required" gateway error.
  // The agent still runs and its output reaches the webchat user through
  // the session transcript / WebSocket stream (session-tool-result-guard
  // emits transcript updates with message payloads that server.impl
  // forwards to subscribed webchat connections).
  const hasExplicitTarget = Boolean(channel && to);

  await callGatewayTool(
    "agent",
    { timeoutMs: 60_000 },
    {
      sessionKey,
      message: buildExecApprovalFollowupPrompt(resultText),
      deliver: hasExplicitTarget,
      bestEffortDeliver: true,
      channel: hasExplicitTarget ? channel : undefined,
      to: hasExplicitTarget ? to : undefined,
      accountId: hasExplicitTarget ? params.turnSourceAccountId?.trim() || undefined : undefined,
      threadId: hasExplicitTarget ? threadId : undefined,
      idempotencyKey: `exec-approval-followup:${params.approvalId}`,
    },
    { expectFinal: true },
  );

  return true;
}
