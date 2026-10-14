import type { ApprovalHandler } from "@muse-code/sdk";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

type MuseApprovalRequest = Parameters<ApprovalHandler>[0];

function selectApprovalChoice(request: MuseApprovalRequest, decision: string | null | undefined) {
  const wanted = decision === "allow-once" ? "approved" : "denied";
  const choice =
    request.availableChoices.find(
      (candidate) => candidate.decision === wanted && candidate.scope === "once",
    ) ??
    (wanted === "denied"
      ? request.availableChoices.find(
          (candidate) => candidate.decision === "denied" || candidate.decision === "abort",
        )
      : undefined);
  if (!choice) {
    throw new Error(`Muse offered no safe ${wanted} approval choice`);
  }
  return { choiceId: choice.choiceId };
}

// Matches the Codex harness: a pending native approval should not hold a turn for hours.
const APPROVAL_TIMEOUT_MS = 120_000;

export function createApprovalHandler(params: AgentHarnessAttemptParamsV2): ApprovalHandler {
  return async (request) => {
    params.hostCapabilities.assertActive();
    const timeoutMs = Math.min(APPROVAL_TIMEOUT_MS, params.timeoutMs);
    // The Gateway approval schema bounds title (80), description (512), and
    // detail (1..16384) characters; Muse commands and arguments can exceed them.
    const answer = await params.hostCapabilities.requestApproval({
      title: `Muse: ${request.toolName}`.slice(0, 80),
      description: (
        request.subject.command ??
        request.subject.path ??
        request.subject.host ??
        request.toolName
      ).slice(0, 512),
      ...(request.rawArgs ? { detail: request.rawArgs.slice(0, 16_384) } : {}),
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      timeoutMs,
      signal: params.abortSignal,
    });
    let decision = answer?.decision;
    if (answer?.id && decision == null) {
      decision = (
        await params.hostCapabilities.waitForApproval({
          approvalId: answer.id,
          timeoutMs,
          signal: params.abortSignal,
        })
      )?.decision;
    }
    params.hostCapabilities.assertActive();
    params.abortSignal?.throwIfAborted();
    return selectApprovalChoice(request, decision);
  };
}
