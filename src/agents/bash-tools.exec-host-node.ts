import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  evaluateShellAllowlist,
  requiresExecApproval,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
} from "../infra/exec-inline-eval.js";
import { detectCommandObfuscation } from "../infra/exec-obfuscation-detect.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { parsePreparedSystemRunPayload } from "../infra/system-run-approval-context.js";
import { logInfo } from "../logger.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import * as execHostShared from "./bash-tools.exec-host-shared.js";
import {
  DEFAULT_NOTIFY_TAIL_CHARS,
  createApprovalSlug,
  normalizeNotifyOutput,
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
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  strictInlineEval?: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  approvalRunningNoticeMs: number;
  warnings: string[];
  notifySessionKey?: string;
  trustedSafeBinDirs?: ReadonlySet<string>;
  /** Maximum command length before triggering obfuscation detection. Default: 10000. */
  maxCommandChars?: number;
};

export async function executeNodeHostCommand(
  params: ExecuteNodeHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  const { hostSecurity, hostAsk, askFallback } = execHostShared.resolveExecHostApprovalContext({
    agentId: params.agentId,
    security: params.security,
    ask: params.ask,
    host: "node",
  });
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
  const runRawCommand = prepared.plan.commandText;
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
  const inlineEvalHit =
    params.strictInlineEval === true
      ? (baseAllowlistEval.segments
          .map((segment) =>
            detectInterpreterInlineEvalArgv(segment.resolution?.effectiveArgv ?? segment.argv),
          )
          .find((entry) => entry !== null) ?? null)
      : null;
  if (inlineEvalHit) {
    params.warnings.push(
      `Warning: strict inline-eval mode requires explicit approval for ${describeInterpreterInlineEval(
        inlineEvalHit,
      )}.`,
    );
  }
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
  const obfuscation = detectCommandObfuscation(params.command, {
    maxCommandChars: params.maxCommandChars,
  });
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
    }) ||
    inlineEvalHit !== null ||
    obfuscation.detected;
  const invokeTimeoutMs = Math.max(
    10_000,
    (typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec) * 1000 +
      5_000,
  );
  const buildInvokeParams = (
    approvedByAsk: boolean,
    approvalDecision: "allow-once" | "allow-always" | null,
    runId?: string,
    suppressNotifyOnExit?: boolean,
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
        approvalDecision:
          approvalDecision === "allow-always" && inlineEvalHit !== null
            ? "allow-once"
            : (approvalDecision ?? undefined),
        runId: runId ?? undefined,
        suppressNotifyOnExit: suppressNotifyOnExit === true ? true : undefined,
      },
      idempotencyKey: crypto.randomUUID(),
    }) satisfies Record<string, unknown>;

  if (requiresAsk) {
    const requestArgs = execHostShared.buildDefaultExecApprovalRequestArgs({
      warnings: params.warnings,
      approvalRunningNoticeMs: params.approvalRunningNoticeMs,
      createApprovalSlug,
      turnSourceChannel: params.turnSourceChannel,
      turnSourceAccountId: params.turnSourceAccountId,
    });
    const registerNodeApproval = async (approvalId: string) =>
      await registerExecApprovalRequestForHostOrThrow({
        approvalId,
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
    const {
      approvalId,
      approvalSlug,
      warningText,
      expiresAtMs,
      preResolvedDecision,
      initiatingSurface,
      sentApproverDms,
      unavailableReason,
    } = await execHostShared.createAndRegisterDefaultExecApprovalRequest({
      ...requestArgs,
      register: registerNodeApproval,
    });
    const followupTarget = execHostShared.buildExecApprovalFollowupTarget({
      approvalId,
      sessionKey: params.notifySessionKey,
      turnSourceChannel: params.turnSourceChannel,
      turnSourceTo: params.turnSourceTo,
      turnSourceAccountId: params.turnSourceAccountId,
      turnSourceThreadId: params.turnSourceThreadId,
    });

    void (async () => {
      const decision = await execHostShared.resolveApprovalDecisionOrUndefined({
        approvalId,
        preResolvedDecision,
        onFailure: () =>
          void execHostShared.sendExecApprovalFollowupResult(
            followupTarget,
            `Exec denied (node=${nodeId} id=${approvalId}, approval-request-failed): ${params.command}`,
          ),
      });
      if (decision === undefined) {
        return;
      }

      const {
        baseDecision,
        approvedByAsk: initialApprovedByAsk,
        deniedReason: initialDeniedReason,
      } = execHostShared.createExecApprovalDecisionState({
        decision,
        askFallback,
        obfuscationDetected: obfuscation.detected,
      });
      let approvedByAsk = initialApprovedByAsk;
      let approvalDecision: "allow-once" | "allow-always" | null = null;
      let deniedReason = initialDeniedReason;

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
        await execHostShared.sendExecApprovalFollowupResult(
          followupTarget,
          `Exec denied (node=${nodeId} id=${approvalId}, ${deniedReason}): ${params.command}`,
        );
        return;
      }

      try {
        const raw = await callGatewayTool<{
          payload?: {
            stdout?: string;
            stderr?: string;
            error?: string | null;
            exitCode?: number | null;
            timedOut?: boolean;
          };
        }>(
          "node.invoke",
          { timeoutMs: invokeTimeoutMs },
          buildInvokeParams(approvedByAsk, approvalDecision, approvalId, true),
        );
        const payload =
          raw?.payload && typeof raw.payload === "object"
            ? (raw.payload as {
                stdout?: string;
                stderr?: string;
                error?: string | null;
                exitCode?: number | null;
                timedOut?: boolean;
              })
            : {};
        const combined = [payload.stdout, payload.stderr, payload.error].filter(Boolean).join("\n");
        const output = normalizeNotifyOutput(combined.slice(-DEFAULT_NOTIFY_TAIL_CHARS));
        const exitLabel = payload.timedOut ? "timeout" : `code ${payload.exitCode ?? "?"}`;
        const summary = output
          ? `Exec finished (node=${nodeId} id=${approvalId}, ${exitLabel})\n${output}`
          : `Exec finished (node=${nodeId} id=${approvalId}, ${exitLabel})`;
        await execHostShared.sendExecApprovalFollowupResult(followupTarget, summary);
      } catch {
        await execHostShared.sendExecApprovalFollowupResult(
          followupTarget,
          `Exec denied (node=${nodeId} id=${approvalId}, invoke-failed): ${params.command}`,
        );
      }
    })();

    return execHostShared.buildExecApprovalPendingToolResult({
      host: "node",
      command: params.command,
      cwd: params.workdir,
      warningText,
      approvalId,
      approvalSlug,
      expiresAtMs,
      initiatingSurface,
      sentApproverDms,
      unavailableReason,
      nodeId,
    });
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
