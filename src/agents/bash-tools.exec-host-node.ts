import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  evaluateShellAllowlist,
  getTrustWindow,
  requiresExecApproval,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import { detectCommandObfuscation } from "../infra/exec-obfuscation-detect.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { parsePreparedSystemRunPayload } from "../infra/system-run-approval-context.js";
import {
  summarizeTrustAudit,
  cleanupTrustAudit,
  appendTrustAuditEntry,
} from "../infra/trust-audit.js";
import { logInfo } from "../logger.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import {
  createDefaultExecApprovalRequestContext,
  resolveBaseExecApprovalDecision,
  resolveApprovalDecisionOrUndefined,
  resolveExecHostApprovalContext,
} from "./bash-tools.exec-host-shared.js";
import { createApprovalSlug, emitExecSystemEvent } from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { callGatewayTool } from "./tools/gateway.js";
import { listNodes, resolveNodeIdFromList } from "./tools/nodes-utils.js";

export type ExecuteNodeHostCommandParams = {
  command: string;
  workdir: string;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  requestedNode?: string;
  boundNode?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  approvalRunningNoticeMs: number;
  warnings: string[];
  notifySessionKey?: string;
  trustedSafeBinDirs?: ReadonlySet<string>;
};

export async function executeNodeHostCommand(
  params: ExecuteNodeHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  let { hostSecurity, hostAsk, askFallback } = resolveExecHostApprovalContext({
    agentId: params.agentId,
    security: params.security,
    ask: params.ask,
    host: "node",
  });

  const agentKey = params.agentId?.trim() || DEFAULT_AGENT_ID;
  const trustWindow = getTrustWindow(agentKey);
  const now = Date.now();
  const trustWindowActive =
    trustWindow?.status === "active" &&
    typeof trustWindow.expiresAt === "number" &&
    now < trustWindow.expiresAt;
  const trustWindowExpired =
    trustWindow?.status === "active" &&
    typeof trustWindow.expiresAt === "number" &&
    now >= trustWindow.expiresAt;

  if (trustWindowActive) {
    hostSecurity = "full";
    hostAsk = "off";
  }

  if (hostSecurity === "deny") {
    throw new Error("exec denied: host=node security=deny");
  }

  if (trustWindowActive && trustWindow?.grantNotified !== true) {
    const remainingMs = trustWindow.expiresAt - now;
    const remainingMin = Math.max(1, Math.ceil(remainingMs / 60_000));
    emitExecSystemEvent(`🔓 Trust window active · expires in ${remainingMin}m`, {
      sessionKey: params.notifySessionKey,
    });
    trustWindow.grantNotified = true;
  }
  if (params.boundNode && params.requestedNode && params.boundNode !== params.requestedNode) {
    throw new Error(`exec node not allowed (bound to ${params.boundNode})`);
  }
  const nodeQuery = params.boundNode || params.requestedNode;
  const nodes = await listNodes({});
  if (nodes.length === 0) {
    throw new Error(
      "exec host=node requires a paired node (none available). This requires a companion app or node host.",
    );
  }
  let nodeId: string;
  try {
    nodeId = resolveNodeIdFromList(nodes, nodeQuery, !nodeQuery);
  } catch (err) {
    if (!nodeQuery && String(err).includes("node required")) {
      throw new Error(
        "exec host=node requires a node id when multiple nodes are available (set tools.exec.node or exec.node).",
        { cause: err },
      );
    }
    throw err;
  }
  const nodeInfo = nodes.find((entry) => entry.nodeId === nodeId);
  const supportsSystemRun = Array.isArray(nodeInfo?.commands)
    ? nodeInfo?.commands?.includes("system.run")
    : false;
  if (!supportsSystemRun) {
    throw new Error(
      "exec host=node requires a node that supports system.run (companion app or node host).",
    );
  }
  const argv = buildNodeShellCommand(params.command, nodeInfo?.platform);
  const prepareRaw = await callGatewayTool<{ payload?: unknown }>(
    "node.invoke",
    { timeoutMs: 15_000 },
    {
      nodeId,
      command: "system.run.prepare",
      params: {
        command: argv,
        rawCommand: params.command,
        cwd: params.workdir,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const prepared = parsePreparedSystemRunPayload(prepareRaw?.payload);
  if (!prepared) {
    throw new Error("invalid system.run.prepare response");
  }
  const runArgv = prepared.plan.argv;
  const runRawCommand = prepared.plan.rawCommand ?? prepared.cmdText;
  const runCwd = prepared.plan.cwd ?? params.workdir;
  const runAgentId = prepared.plan.agentId ?? params.agentId;
  const runSessionKey = prepared.plan.sessionKey ?? params.sessionKey;

  const nodeEnv = params.requestedEnv ? { ...params.requestedEnv } : undefined;
  const baseAllowlistEval = evaluateShellAllowlist({
    command: params.command,
    allowlist: [],
    safeBins: new Set(),
    cwd: params.workdir,
    env: params.env,
    platform: nodeInfo?.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
  });
  let analysisOk = baseAllowlistEval.analysisOk;
  let allowlistSatisfied = false;
  if (hostAsk === "on-miss" && hostSecurity === "allowlist" && analysisOk) {
    try {
      const approvalsSnapshot = await callGatewayTool<{ file: string }>(
        "exec.approvals.node.get",
        { timeoutMs: 10_000 },
        { nodeId },
      );
      const approvalsFile =
        approvalsSnapshot && typeof approvalsSnapshot === "object"
          ? approvalsSnapshot.file
          : undefined;
      if (approvalsFile && typeof approvalsFile === "object") {
        const resolved = resolveExecApprovalsFromFile({
          file: approvalsFile as ExecApprovalsFile,
          agentId: params.agentId,
          overrides: { security: "allowlist" },
        });
        // Allowlist-only precheck; safe bins are node-local and may diverge.
        const allowlistEval = evaluateShellAllowlist({
          command: params.command,
          allowlist: resolved.allowlist,
          safeBins: new Set(),
          cwd: params.workdir,
          env: params.env,
          platform: nodeInfo?.platform,
          trustedSafeBinDirs: params.trustedSafeBinDirs,
        });
        allowlistSatisfied = allowlistEval.allowlistSatisfied;
        analysisOk = allowlistEval.analysisOk;
      }
    } catch {
      // Fall back to requiring approval if node approvals cannot be fetched.
    }
  }
  const obfuscation = detectCommandObfuscation(params.command);
  if (obfuscation.detected) {
    logInfo(
      `exec: obfuscation detected (node=${nodeQuery ?? "default"}): ${obfuscation.reasons.join(", ")}`,
    );
    params.warnings.push(`⚠️ Obfuscated command detected: ${obfuscation.reasons.join("; ")}`);
  }
  const requiresAsk =
    requiresExecApproval({
      ask: hostAsk,
      security: hostSecurity,
      analysisOk,
      allowlistSatisfied,
    }) || obfuscation.detected;

  if (trustWindowExpired && trustWindow?.expiredNotified !== true) {
    emitExecSystemEvent("🔒 Trust window expired. Exec approval required for new commands.", {
      sessionKey: params.notifySessionKey,
    });
    const summary = summarizeTrustAudit({
      agentId: agentKey,
      startedAt: trustWindow.grantedAt,
      endedAt: trustWindow.expiresAt ?? now,
    });
    if (summary) {
      emitExecSystemEvent(summary, { sessionKey: params.notifySessionKey });
    }
    cleanupTrustAudit(agentKey);
    trustWindow.expiredNotified = true;
  }

  const invokeTimeoutMs = Math.max(
    10_000,
    (typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec) * 1000 +
      5_000,
  );
  const buildInvokeParams = (
    approvedByAsk: boolean,
    approvalDecision: "allow-once" | "allow-always" | null,
    runId?: string,
  ) =>
    ({
      nodeId,
      command: "system.run",
      params: {
        command: runArgv,
        rawCommand: runRawCommand,
        cwd: runCwd,
        env: nodeEnv,
        timeoutMs: typeof params.timeoutSec === "number" ? params.timeoutSec * 1000 : undefined,
        agentId: runAgentId,
        sessionKey: runSessionKey,
        approved: approvedByAsk,
        approvalDecision: approvalDecision ?? undefined,
        runId: runId ?? undefined,
      },
      idempotencyKey: crypto.randomUUID(),
    }) satisfies Record<string, unknown>;

  if (requiresAsk) {
    const {
      approvalId,
      approvalSlug,
      contextKey,
      noticeSeconds,
      warningText,
      expiresAtMs: defaultExpiresAtMs,
      preResolvedDecision: defaultPreResolvedDecision,
    } = createDefaultExecApprovalRequestContext({
      warnings: params.warnings,
      approvalRunningNoticeMs: params.approvalRunningNoticeMs,
      createApprovalSlug,
    });
    let expiresAtMs = defaultExpiresAtMs;
    let preResolvedDecision = defaultPreResolvedDecision;

    // Register first so the returned approval ID is actionable immediately.
    const registration = await registerExecApprovalRequestForHostOrThrow({
      approvalId,
      command: prepared.cmdText,
      commandArgv: prepared.plan.argv,
      systemRunPlan: prepared.plan,
      env: nodeEnv,
      workdir: runCwd,
      host: "node",
      nodeId,
      security: hostSecurity,
      ask: hostAsk,
      ...buildExecApprovalRequesterContext({
        agentId: runAgentId,
        sessionKey: runSessionKey,
      }),
      ...buildExecApprovalTurnSourceContext(params),
    });
    expiresAtMs = registration.expiresAtMs;
    preResolvedDecision = registration.finalDecision;

    void (async () => {
      const decision = await resolveApprovalDecisionOrUndefined({
        approvalId,
        preResolvedDecision,
        onFailure: () =>
          emitExecSystemEvent(
            `Exec denied (node=${nodeId} id=${approvalId}, approval-request-failed): ${params.command}`,
            { sessionKey: params.notifySessionKey, contextKey },
          ),
      });
      if (decision === undefined) {
        return;
      }

      const baseDecision = resolveBaseExecApprovalDecision({
        decision,
        askFallback,
        obfuscationDetected: obfuscation.detected,
      });
      let approvedByAsk = baseDecision.approvedByAsk;
      let approvalDecision: "allow-once" | "allow-always" | null = null;
      let deniedReason = baseDecision.deniedReason;

      if (baseDecision.timedOut && askFallback === "full" && approvedByAsk) {
        approvalDecision = "allow-once";
      } else if (decision === "allow-once") {
        approvedByAsk = true;
        approvalDecision = "allow-once";
      } else if (decision === "allow-always") {
        approvedByAsk = true;
        approvalDecision = "allow-always";
      }

      if (deniedReason) {
        emitExecSystemEvent(
          `Exec denied (node=${nodeId} id=${approvalId}, ${deniedReason}): ${params.command}`,
          {
            sessionKey: params.notifySessionKey,
            contextKey,
          },
        );
        return;
      }

      let runningTimer: NodeJS.Timeout | null = null;
      if (params.approvalRunningNoticeMs > 0) {
        runningTimer = setTimeout(() => {
          emitExecSystemEvent(
            `Exec running (node=${nodeId} id=${approvalId}, >${noticeSeconds}s): ${params.command}`,
            { sessionKey: params.notifySessionKey, contextKey },
          );
        }, params.approvalRunningNoticeMs);
      }

      try {
        await callGatewayTool(
          "node.invoke",
          { timeoutMs: invokeTimeoutMs },
          buildInvokeParams(approvedByAsk, approvalDecision, approvalId),
        );
      } catch {
        emitExecSystemEvent(
          `Exec denied (node=${nodeId} id=${approvalId}, invoke-failed): ${params.command}`,
          {
            sessionKey: params.notifySessionKey,
            contextKey,
          },
        );
      } finally {
        if (runningTimer) {
          clearTimeout(runningTimer);
        }
      }
    })();

    return {
      content: [
        {
          type: "text",
          text:
            `${warningText}Approval required (id ${approvalSlug}). ` +
            "Approve to run; updates will arrive after completion.",
        },
      ],
      details: {
        status: "approval-pending",
        approvalId,
        approvalSlug,
        expiresAtMs,
        host: "node",
        command: params.command,
        cwd: params.workdir,
        nodeId,
      },
    };
  }

  const startedAt = Date.now();
  const raw = await callGatewayTool(
    "node.invoke",
    { timeoutMs: invokeTimeoutMs },
    buildInvokeParams(false, null),
  );
  const payload =
    raw && typeof raw === "object" ? (raw as { payload?: unknown }).payload : undefined;
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const stdout = typeof payloadObj.stdout === "string" ? payloadObj.stdout : "";
  const stderr = typeof payloadObj.stderr === "string" ? payloadObj.stderr : "";
  const errorText = typeof payloadObj.error === "string" ? payloadObj.error : "";
  const success = typeof payloadObj.success === "boolean" ? payloadObj.success : false;
  const exitCode = typeof payloadObj.exitCode === "number" ? payloadObj.exitCode : null;
  const durationMs = Date.now() - startedAt;

  if (trustWindowActive) {
    appendTrustAuditEntry({
      agentId: agentKey,
      command: params.command,
      exitCode: exitCode ?? (success ? 0 : null),
      durationMs,
    });
  }

  return {
    content: [
      {
        type: "text",
        text: stdout || stderr || errorText || "",
      },
    ],
    details: {
      status: success ? "completed" : "failed",
      exitCode,
      durationMs,
      aggregated: [stdout, stderr, errorText].filter(Boolean).join("\n"),
      cwd: params.workdir,
    } satisfies ExecToolDetails,
  };
}
