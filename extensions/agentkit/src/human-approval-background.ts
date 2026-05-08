import {
  buildApprovalPendingReplyPayload,
  type ExecApprovalDecision,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { withOperatorAdminGatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import type { AgentkitPluginConfig } from "./config.js";
import type { AgentkitPendingApproval } from "./hitl-approvals.js";
import {
  filterMatchingPendingAgentkitApprovals,
  formatPendingAgentkitApprovalsText,
  listPendingAgentkitApprovals,
  resolvePendingAgentkitApproval,
  sortPendingAgentkitApprovals,
} from "./hitl-approvals.js";
import { saveAgentkitHitlGrant } from "./hitl-grants.js";
import {
  buildHumanApprovalPendingActions,
  buildHumanApprovalRetryActions,
} from "./human-approval-actions.js";
import {
  startAgentkitWorldHumanApprovalSession,
  type AgentkitHumanApprovalSessionResult,
} from "./human-approval.js";
import { renderQrCodeToString } from "./qr.runtime.js";

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type AgentkitHumanApprovalBackgroundSession = {
  action: string;
  approvalId: string;
  connectorURI: string;
  decision: ExecApprovalDecision;
  qrText: string | null;
  requestId: string;
  reused: boolean;
};

type ActiveHumanApprovalSession = AgentkitHumanApprovalBackgroundSession & {
  completionPromise: Promise<void>;
};

const activeHumanApprovalSessions = new Map<string, ActiveHumanApprovalSession>();

function extractVerificationDetail(verifyBody: unknown): string | null {
  if (typeof verifyBody === "string") {
    const trimmed = verifyBody.trim();
    return trimmed ? trimmed : null;
  }
  if (!verifyBody || typeof verifyBody !== "object" || Array.isArray(verifyBody)) {
    return null;
  }
  const record = verifyBody as Record<string, unknown>;
  for (const key of ["code", "detail", "error", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function buildWorldFailureTitle(approval: AgentkitPendingApproval): string {
  return `World verification failed for ${approval.request.toolName ?? "this action"}`;
}

function formatWorldFailureMessage(params: {
  approval: AgentkitPendingApproval;
  result: AgentkitHumanApprovalSessionResult;
}): string {
  const lines = [
    "World verification did not complete, so the protected OpenClaw action is still waiting for approval.",
    `Approval ID: ${params.approval.id}`,
    `World request ID: ${params.result.requestId}`,
  ];
  if (params.result.errorCode) {
    lines.push(`World error: ${params.result.errorCode}`);
  }
  if (params.result.verifyStatus != null) {
    lines.push(`Verification status: ${params.result.verifyStatus}`);
  }
  const detail = extractVerificationDetail(params.result.verifyBody);
  if (detail) {
    lines.push(`Verification detail: ${detail}`);
  }
  lines.push("");
  lines.push("Retry with World to generate a fresh QR, or deny the action.");
  return lines.join("\n");
}

async function injectPendingRetryPrompt(params: {
  appConfig: OpenClawConfig;
  approval: AgentkitPendingApproval;
  gatewayUrl?: string;
  pluginConfig: AgentkitPluginConfig;
  result: AgentkitHumanApprovalSessionResult;
}): Promise<void> {
  const sessionKey = params.approval.request.sessionKey;
  if (!sessionKey) {
    return;
  }
  const payload = buildApprovalPendingReplyPayload({
    approvalKind: "plugin",
    approvalId: params.approval.id,
    approvalSlug: params.approval.id.slice(0, 8),
    text: formatWorldFailureMessage({
      approval: params.approval,
      result: params.result,
    }),
    actions: buildHumanApprovalRetryActions({
      approvalId: params.approval.id,
      pluginConfig: params.pluginConfig,
    }),
    title: buildWorldFailureTitle(params.approval),
    description:
      "The action is still blocked. Retry the World verification flow or deny the request.",
    severity: params.approval.request.severity ?? "warning",
    toolName: params.approval.request.toolName ?? undefined,
    pluginId: params.approval.request.pluginId ?? "agentkit",
    agentId: params.approval.request.agentId ?? undefined,
    sessionKey,
  });
  await withOperatorAdminGatewayClient(
    {
      config: params.appConfig,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: "AgentKit approval retry",
    },
    async (client) => {
      await client.request("chat.inject", {
        sessionKey,
        message: payload.text,
        command: true,
        interactive: payload.interactive,
        channelData: payload.channelData,
        idempotencyKey: `plugin-approval:${params.approval.id}:world-failure:${params.result.requestId}`,
      });
    },
  );
}

function canPersistGrant(params: {
  approval: AgentkitPendingApproval;
  decision: ExecApprovalDecision;
  pluginConfig: AgentkitPluginConfig;
}): boolean {
  if (params.decision !== "allow-always") {
    return false;
  }
  return params.pluginConfig.hitl.grantScope === "agent"
    ? params.approval.request.agentId != null
    : params.approval.request.sessionKey != null;
}

function approvalMatchesSessionScope(params: {
  approval: AgentkitPendingApproval;
  candidate: AgentkitPendingApproval;
}): boolean {
  if (params.candidate.id === params.approval.id) {
    return false;
  }
  return (
    params.approval.request.sessionKey != null &&
    params.candidate.request.sessionKey === params.approval.request.sessionKey &&
    params.candidate.request.toolName === params.approval.request.toolName
  );
}

async function listMatchingPendingApprovals(params: {
  appConfig: OpenClawConfig;
  approval: AgentkitPendingApproval;
  gatewayUrl?: string;
  pluginConfig: AgentkitPluginConfig;
}): Promise<AgentkitPendingApproval[]> {
  const approvals = await listPendingAgentkitApprovals({
    appConfig: params.appConfig,
    gatewayUrl: params.gatewayUrl,
  });
  return filterMatchingPendingAgentkitApprovals({
    approvals,
    approval: params.approval,
    pluginConfig: params.pluginConfig,
  });
}

async function listRemainingPendingApprovalsForSession(params: {
  appConfig: OpenClawConfig;
  approval: AgentkitPendingApproval;
  gatewayUrl?: string;
}): Promise<AgentkitPendingApproval[]> {
  const approvals = await listPendingAgentkitApprovals({
    appConfig: params.appConfig,
    gatewayUrl: params.gatewayUrl,
  });
  return sortPendingAgentkitApprovals(
    approvals.filter((candidate) =>
      approvalMatchesSessionScope({
        approval: params.approval,
        candidate,
      }),
    ),
  );
}

async function resolveMatchingPendingApprovals(params: {
  appConfig: OpenClawConfig;
  approval: AgentkitPendingApproval;
  decision: Extract<ExecApprovalDecision, "allow-always">;
  gatewayUrl?: string;
  logger?: LoggerLike;
  pluginConfig: AgentkitPluginConfig;
}): Promise<void> {
  const matching = await listMatchingPendingApprovals({
    appConfig: params.appConfig,
    approval: params.approval,
    gatewayUrl: params.gatewayUrl,
    pluginConfig: params.pluginConfig,
  });
  await Promise.all(
    matching.map(async (approval) => {
      try {
        await resolvePendingAgentkitApproval({
          appConfig: params.appConfig,
          approvalId: approval.id,
          decision: params.decision,
          gatewayUrl: params.gatewayUrl,
        });
      } catch (error) {
        params.logger?.warn?.(
          `agentkit: failed to resolve matching pending approval ${approval.id}: ${String(error)}`,
        );
      }
    }),
  );
}

function formatRemainingPendingApprovalsMessage(params: {
  approval: AgentkitPendingApproval;
  remaining: AgentkitPendingApproval[];
}): string {
  const toolName = params.approval.request.toolName ?? "this tool";
  const count = params.remaining.length;
  const approvalLabel = count === 1 ? "approval is" : "approvals are";
  return [
    `World verification approved one \`${toolName}\` request, but ${count} more AgentKit ${approvalLabel} still pending for this session.`,
    "The agent turn will not finish until every blocked tool call is resolved.",
    "",
    formatPendingAgentkitApprovalsText(params.remaining),
    "",
    "Approve the remaining request, deny it, or use `Verify and trust for session` on a pending request to cover this tool for the session.",
  ].join("\n");
}

async function injectRemainingPendingApprovalsPrompt(params: {
  appConfig: OpenClawConfig;
  approval: AgentkitPendingApproval;
  gatewayUrl?: string;
  logger?: LoggerLike;
  pluginConfig: AgentkitPluginConfig;
}): Promise<void> {
  const sessionKey = params.approval.request.sessionKey;
  if (!sessionKey) {
    return;
  }
  const remaining = await listRemainingPendingApprovalsForSession({
    appConfig: params.appConfig,
    approval: params.approval,
    gatewayUrl: params.gatewayUrl,
  });
  if (remaining.length === 0) {
    return;
  }
  const nextApproval = remaining[0];
  if (!nextApproval) {
    return;
  }
  try {
    await withOperatorAdminGatewayClient(
      {
        config: params.appConfig,
        gatewayUrl: params.gatewayUrl,
        clientDisplayName: "AgentKit pending approval reminder",
      },
      async (client) => {
        const payload = buildApprovalPendingReplyPayload({
          approvalKind: "plugin",
          approvalId: nextApproval.id,
          approvalSlug: nextApproval.id.slice(0, 8),
          text: formatRemainingPendingApprovalsMessage({
            approval: params.approval,
            remaining,
          }),
          actions: buildHumanApprovalPendingActions({
            approvalId: nextApproval.id,
            pluginConfig: params.pluginConfig,
          }),
          title: nextApproval.request.title,
          description:
            nextApproval.request.description ||
            "The agent turn is still blocked. Verify with World or deny the request.",
          severity: nextApproval.request.severity ?? "warning",
          toolName: nextApproval.request.toolName ?? undefined,
          pluginId: nextApproval.request.pluginId ?? "agentkit",
          agentId: nextApproval.request.agentId ?? undefined,
          sessionKey,
        });
        await client.request("chat.inject", {
          sessionKey,
          message: payload.text,
          command: true,
          interactive: payload.interactive,
          channelData: payload.channelData,
          idempotencyKey: `plugin-approval:${params.approval.id}:remaining-pending`,
        });
      },
    );
  } catch (error) {
    params.logger?.warn?.(
      `agentkit: failed to inject remaining pending approvals prompt for ${params.approval.id}: ${String(
        error,
      )}`,
    );
  }
}

async function completeHumanApprovalSession(params: {
  appConfig: OpenClawConfig;
  approval: AgentkitPendingApproval;
  decision: ExecApprovalDecision;
  env?: NodeJS.ProcessEnv;
  gatewayUrl?: string;
  logger?: LoggerLike;
  pluginConfig: AgentkitPluginConfig;
}): Promise<ActiveHumanApprovalSession> {
  const pending = await startAgentkitWorldHumanApprovalSession({
    approval: params.approval,
    pluginConfig: params.pluginConfig,
    env: params.env,
    timeoutMs: params.pluginConfig.hitl.timeoutMs,
  });
  const qrText = await renderQrCodeToString(pending.connectorURI);
  const session: ActiveHumanApprovalSession = {
    action: pending.action,
    approvalId: params.approval.id,
    connectorURI: pending.connectorURI,
    decision: params.decision,
    qrText,
    requestId: pending.requestId,
    reused: false,
    completionPromise: Promise.resolve(),
  };
  session.completionPromise = pending
    .waitForCompletion()
    .then(async (result) => {
      if (!result.success) {
        params.logger?.warn?.(
          result.errorCode
            ? `agentkit: World approval did not complete (${result.errorCode}) for ${params.approval.id}`
            : `agentkit: World approval verification failed for ${params.approval.id} (status ${result.verifyStatus ?? "unknown"})`,
        );
        await injectPendingRetryPrompt({
          appConfig: params.appConfig,
          approval: params.approval,
          gatewayUrl: params.gatewayUrl,
          pluginConfig: params.pluginConfig,
          result,
        });
        return;
      }

      await resolvePendingAgentkitApproval({
        appConfig: params.appConfig,
        approvalId: params.approval.id,
        decision: params.decision,
        gatewayUrl: params.gatewayUrl,
      });

      const shouldPersistGrant = canPersistGrant({
        approval: params.approval,
        decision: params.decision,
        pluginConfig: params.pluginConfig,
      });
      if (shouldPersistGrant) {
        const grantDecision =
          params.decision === "allow-always" ? "allow-always" : ("allow-once" as const);
        const nowMs = Date.now();
        saveAgentkitHitlGrant({
          appConfig: params.appConfig,
          pluginConfig: params.pluginConfig,
          grant: {
            id: `${params.approval.id}:${params.decision}`,
            approvalMode: "human-approval",
            resourceUrl: null,
            decision: grantDecision,
            scope: {
              toolName: params.approval.request.toolName ?? "unknown",
              sessionKey: params.approval.request.sessionKey,
              agentId: params.approval.request.agentId,
            },
            humanLookupMode: "world-id",
            signerAddress: null,
            proofNullifier: result.nullifier,
            grantedAtMs: nowMs,
            expiresAtMs:
              params.decision === "allow-always"
                ? nowMs + params.pluginConfig.hitl.grantTtlMs
                : null,
            consumedAtMs: null,
          },
        });
      }

      if (params.decision === "allow-always" && shouldPersistGrant) {
        await resolveMatchingPendingApprovals({
          appConfig: params.appConfig,
          approval: params.approval,
          decision: params.decision,
          gatewayUrl: params.gatewayUrl,
          logger: params.logger,
          pluginConfig: params.pluginConfig,
        });
      } else if (params.decision === "allow-once") {
        await injectRemainingPendingApprovalsPrompt({
          appConfig: params.appConfig,
          approval: params.approval,
          gatewayUrl: params.gatewayUrl,
          logger: params.logger,
          pluginConfig: params.pluginConfig,
        });
      }
    })
    .catch(async (error) => {
      params.logger?.error?.(
        `agentkit: World human approval background flow failed for ${params.approval.id}: ${String(error)}`,
      );
      await injectPendingRetryPrompt({
        appConfig: params.appConfig,
        approval: params.approval,
        gatewayUrl: params.gatewayUrl,
        pluginConfig: params.pluginConfig,
        result: {
          success: false,
          action: session.action,
          approvalId: params.approval.id,
          connectorURI: session.connectorURI,
          requestId: session.requestId,
          verifyStatus: null,
          verifyBody: null,
          errorCode: error instanceof Error ? error.message : "unexpected_failure",
          nullifier: null,
        },
      });
    })
    .finally(() => {
      activeHumanApprovalSessions.delete(params.approval.id);
    });
  activeHumanApprovalSessions.set(params.approval.id, session);
  return session;
}

export async function startOrReuseAgentkitHumanApprovalSession(params: {
  appConfig: OpenClawConfig;
  approval: AgentkitPendingApproval;
  decision?: ExecApprovalDecision;
  env?: NodeJS.ProcessEnv;
  gatewayUrl?: string;
  logger?: LoggerLike;
  pluginConfig: AgentkitPluginConfig;
}): Promise<AgentkitHumanApprovalBackgroundSession> {
  const existing = activeHumanApprovalSessions.get(params.approval.id);
  if (existing) {
    return {
      action: existing.action,
      approvalId: existing.approvalId,
      connectorURI: existing.connectorURI,
      decision: existing.decision,
      qrText: existing.qrText,
      requestId: existing.requestId,
      reused: true,
    };
  }

  const session = await completeHumanApprovalSession({
    appConfig: params.appConfig,
    approval: params.approval,
    decision: params.decision ?? "allow-once",
    env: params.env,
    gatewayUrl: params.gatewayUrl,
    logger: params.logger,
    pluginConfig: params.pluginConfig,
  });
  return {
    action: session.action,
    approvalId: session.approvalId,
    connectorURI: session.connectorURI,
    decision: session.decision,
    qrText: session.qrText,
    requestId: session.requestId,
    reused: false,
  };
}

export const __testing = {
  activeHumanApprovalSessions,
};
