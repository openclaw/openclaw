import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  withOperatorAdminGatewayClient,
  withOperatorApprovalsGatewayClient,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { AgentkitPluginConfig } from "./config.js";

export type AgentkitPendingApproval = {
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
  request: {
    pluginId: string | null;
    title: string;
    description: string;
    severity: "info" | "warning" | "critical" | null;
    toolName: string | null;
    toolCallId: string | null;
    agentId: string | null;
    sessionKey: string | null;
  };
};

function asPendingApproval(value: unknown): AgentkitPendingApproval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.createdAtMs !== "number" ||
    typeof record.expiresAtMs !== "number" ||
    !record.request ||
    typeof record.request !== "object" ||
    Array.isArray(record.request)
  ) {
    return null;
  }
  const request = record.request as Record<string, unknown>;
  return {
    id: record.id,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    request: {
      pluginId: typeof request.pluginId === "string" ? request.pluginId : null,
      title: typeof request.title === "string" ? request.title : "",
      description: typeof request.description === "string" ? request.description : "",
      severity:
        request.severity === "info" ||
        request.severity === "critical" ||
        request.severity === "warning"
          ? request.severity
          : null,
      toolName: typeof request.toolName === "string" ? request.toolName : null,
      toolCallId: typeof request.toolCallId === "string" ? request.toolCallId : null,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
    },
  };
}

export async function listPendingAgentkitApprovals(params: {
  appConfig: OpenClawConfig;
  gatewayUrl?: string;
}): Promise<AgentkitPendingApproval[]> {
  return await withOperatorApprovalsGatewayClient(
    {
      config: params.appConfig,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: "AgentKit approvals",
    },
    async (client) => {
      const raw = await client.request("plugin.approval.list", {});
      if (!Array.isArray(raw)) {
        return [];
      }
      return raw
        .map(asPendingApproval)
        .filter(
          (entry): entry is AgentkitPendingApproval => entry?.request.pluginId === "agentkit",
        );
    },
  );
}

export function resolveRequestedAgentkitApproval(params: {
  approvals: AgentkitPendingApproval[];
  approvalId?: string;
}): AgentkitPendingApproval {
  if (params.approvalId) {
    const match = params.approvals.find((entry) => entry.id === params.approvalId);
    if (!match) {
      throw new Error(`Pending AgentKit approval not found: ${params.approvalId}`);
    }
    return match;
  }
  if (params.approvals.length === 1) {
    return params.approvals[0];
  }
  if (params.approvals.length === 0) {
    throw new Error("No pending AgentKit approvals were found.");
  }
  throw new Error(
    "Multiple pending AgentKit approvals were found. Re-run with --approval-id <id>.",
  );
}

function approvalMatchesGrantScope(params: {
  approval: AgentkitPendingApproval;
  candidate: AgentkitPendingApproval;
  pluginConfig: AgentkitPluginConfig;
}): boolean {
  if (params.candidate.id === params.approval.id) {
    return false;
  }
  if (params.candidate.request.toolName !== params.approval.request.toolName) {
    return false;
  }
  if (params.pluginConfig.hitl.grantScope === "agent") {
    return (
      params.approval.request.agentId != null &&
      params.candidate.request.agentId === params.approval.request.agentId
    );
  }
  return (
    params.approval.request.sessionKey != null &&
    params.candidate.request.sessionKey === params.approval.request.sessionKey
  );
}

export function sortPendingAgentkitApprovals(
  approvals: AgentkitPendingApproval[],
): AgentkitPendingApproval[] {
  return approvals.toSorted((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
}

export function filterMatchingPendingAgentkitApprovals(params: {
  approvals: AgentkitPendingApproval[];
  approval: AgentkitPendingApproval;
  pluginConfig: AgentkitPluginConfig;
}): AgentkitPendingApproval[] {
  return sortPendingAgentkitApprovals(
    params.approvals.filter((candidate) =>
      approvalMatchesGrantScope({
        approval: params.approval,
        candidate,
        pluginConfig: params.pluginConfig,
      }),
    ),
  );
}

export async function resolvePendingAgentkitApproval(params: {
  appConfig: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalDecision;
  gatewayUrl?: string;
}): Promise<void> {
  await withOperatorAdminGatewayClient(
    {
      config: params.appConfig,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: "AgentKit proof-backed approval",
    },
    async (client) => {
      await client.request("plugin.approval.resolveVerified", {
        id: params.approvalId,
        decision: params.decision,
        pluginId: "agentkit",
      });
    },
  );
}

export function formatPendingAgentkitApprovalsText(
  approvals: AgentkitPendingApproval[],
  nowMs = Date.now(),
): string {
  if (approvals.length === 0) {
    return "No pending AgentKit approvals.";
  }
  return [
    "Pending AgentKit approvals:",
    ...approvals.map((approval) => {
      const expiresInSeconds = Math.max(0, Math.round((approval.expiresAtMs - nowMs) / 1000));
      return [
        `- ${approval.id}`,
        `  tool: ${approval.request.toolName ?? "unknown"}`,
        `  title: ${approval.request.title}`,
        `  agent: ${approval.request.agentId ?? "unknown"}`,
        `  session: ${approval.request.sessionKey ?? "unknown"}`,
        `  expires in: ${expiresInSeconds}s`,
      ].join("\n");
    }),
  ].join("\n");
}
