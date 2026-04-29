// Approval-flow wrappers around the generic plugin.approval.request /
// plugin.approval.waitDecision gateway methods.
//
// Used by the file-transfer policy gate when ask=on-miss/always: the
// operator sees a modal in their macOS/iOS app with allow-once /
// allow-always / deny.

import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { GatewayCallOptions } from "./params.js";

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ApprovalOutcome = {
  decision: ApprovalDecision | null;
  approvalId?: string;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const PLUGIN_ID = "file-transfer";

/**
 * Issue a two-phase plugin.approval.request and wait for the operator's
 * decision. Returns null decision if the request was unavailable (e.g.,
 * no operator client connected) — caller should then fall back to deny.
 */
export async function requestFileTransferApproval(input: {
  gatewayOpts: GatewayCallOptions;
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical";
  toolName: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  timeoutMs?: number;
}): Promise<ApprovalOutcome> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  type RequestResult = { id?: string; decision?: ApprovalDecision | null };

  const requestResult = (await callGatewayTool(
    "plugin.approval.request",
    {
      ...input.gatewayOpts,
      timeoutMs: timeoutMs + 10_000,
    },
    {
      pluginId: PLUGIN_ID,
      title: input.title.slice(0, 80),
      description: input.description.slice(0, 256),
      severity: input.severity ?? "warning",
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      timeoutMs,
      twoPhase: true,
    },
  )) as RequestResult | undefined;

  if (!requestResult || requestResult.decision === null) {
    // Approval system explicitly declined or no operator available.
    return { decision: null };
  }

  // Two-phase: if the request returned a synchronous decision, use it;
  // otherwise wait on the approval id.
  if (requestResult.decision) {
    return { decision: requestResult.decision, approvalId: requestResult.id };
  }
  if (!requestResult.id) {
    return { decision: null };
  }

  type WaitResult = { id?: string; decision?: ApprovalDecision | null };
  const waitResult = (await callGatewayTool(
    "plugin.approval.waitDecision",
    {
      ...input.gatewayOpts,
      timeoutMs: timeoutMs + 10_000,
    },
    { id: requestResult.id },
  )) as WaitResult | undefined;

  return {
    decision: waitResult?.decision ?? null,
    approvalId: requestResult.id,
  };
}
