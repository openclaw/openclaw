import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  evaluateShellAllowlist,
  maxAsk,
  minSecurity,
  requiresExecApproval,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import {
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  createApprovalSlug,
  emitExecSystemEvent,
} from "./bash-tools.exec-runtime.js";
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
  const approvals = resolveExecApprovals(params.agentId, {
    security: params.security,
    ask: params.ask,
  });
  const hostSecurity = minSecurity(params.security, approvals.agent.security);
  const hostAsk = maxAsk(params.ask, approvals.agent.ask);
  const askFallback = approvals.agent.askFallback;
  if (hostSecurity === "deny") {
    throw new Error("exec denied: host=node security=deny");
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
  const requiresAsk = requiresExecApproval({
    ask: hostAsk,
    security: hostSecurity,
    analysisOk,
    allowlistSatisfied,
  });
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
        command: argv,
        rawCommand: params.command,
        cwd: params.workdir,
        env: nodeEnv,
        timeoutMs: typeof params.timeoutSec === "number" ? params.timeoutSec * 1000 : undefined,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        approved: approvedByAsk,
        approvalDecision: approvalDecision ?? undefined,
        runId: runId ?? undefined,
      },
      idempotencyKey: crypto.randomUUID(),
    }) satisfies Record<string, unknown>;

  if (requiresAsk) {
    const approvalId = crypto.randomUUID();
    const approvalSlug = createApprovalSlug(approvalId);
    const expiresAtMs = Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
    const contextKey = `exec:${approvalId}`;
    const noticeSeconds = Math.max(1, Math.round(params.approvalRunningNoticeMs / 1000));
    const warningText = params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "";

    void (async () => {
      let decision: string | null = null;
      try {
        const decisionResult = await callGatewayTool<{ decision: string }>(
          "exec.approval.request",
          { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
          {
            id: approvalId,
            command: params.command,
            cwd: params.workdir,
            host: "node",
            security: hostSecurity,
            ask: hostAsk,
            agentId: params.agentId,
            resolvedPath: undefined,
            sessionKey: params.sessionKey,
            timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
          },
        );
        const decisionValue =
          decisionResult && typeof decisionResult === "object"
            ? (decisionResult as { decision?: unknown }).decision
            : undefined;
        decision = typeof decisionValue === "string" ? decisionValue : null;
      } catch {
        emitExecSystemEvent(
          `Exec denied (node=${nodeId} id=${approvalId}, approval-request-failed): ${params.command}`,
          { sessionKey: params.notifySessionKey, contextKey },
        );
        return;
      }

      let approvedByAsk = false;
      let approvalDecision: "allow-once" | "allow-always" | null = null;
      let deniedReason: string | null = null;

      if (decision === "deny") {
        deniedReason = "user-denied";
      } else if (!decision) {
        if (askFallback === "full") {
          approvedByAsk = true;
          approvalDecision = "allow-once";
        } else if (askFallback === "allowlist") {
          // Defer allowlist enforcement to the node host.
        } else {
          deniedReason = "approval-timeout";
        }
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
      durationMs: Date.now() - startedAt,
      aggregated: [stdout, stderr, errorText].filter(Boolean).join("\n"),
      cwd: params.workdir,
    } satisfies ExecToolDetails,
  };
}
