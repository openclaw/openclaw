import type { ApprovalHandler } from "@muse-code/sdk";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function createMuseApprovalHandler(
  params: AgentHarnessAttemptParamsV2,
  recordFailure: (error: Error) => void,
): ApprovalHandler {
  return async (request) => {
    params.hostCapabilities.assertActive();
    const timeoutMs = Math.min(120_000, params.timeoutMs);
    let decision: string | null | undefined;
    try {
      // The host schema bounds titles to 80, descriptions to 512, and details
      // to 16,384 characters; native commands can exceed these limits.
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
      decision = answer?.decision;
      if (answer?.id && decision == null) {
        decision = (
          await params.hostCapabilities.waitForApproval({
            approvalId: answer.id,
            timeoutMs,
            signal: params.abortSignal,
          })
        )?.decision;
      }
    } catch (error) {
      // A current owner may fail closed using a choice Muse actually offered.
      // Revoked authority cannot make even that native decision.
      params.hostCapabilities.assertActive();
      params.abortSignal?.throwIfAborted();
      const refusal = selectApprovalChoice(request, "deny");
      recordFailure(new Error(`Muse approval failed: ${formatErrorMessage(error)}`));
      return refusal;
    }
    params.hostCapabilities.assertActive();
    params.abortSignal?.throwIfAborted();
    return selectApprovalChoice(request, decision);
  };
}

export function selectApprovalChoice(
  request: Parameters<ApprovalHandler>[0],
  decision: string | null | undefined,
) {
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
