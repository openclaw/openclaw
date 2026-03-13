import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { loadConfig } from "../config/config.js";
import { buildExecApprovalUnavailableReplyPayload } from "../infra/exec-approval-reply.js";
import {
  hasConfiguredExecApprovalDmRoute,
  resolveExecApprovalInitiatingSurfaceState,
} from "../infra/exec-approval-surface.js";
import {
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  evaluateShellAllowlist,
  requiresExecApproval,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import { detectCommandObfuscation } from "../infra/exec-obfuscation-detect.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { parsePreparedSystemRunPayload } from "../infra/system-run-approval-context.js";
import { logInfo } from "../logger.js";
import { checkCommandSecurity } from "../security/command-security.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
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
import {
  buildApprovalPendingMessage,
  DEFAULT_NOTIFY_TAIL_CHARS,
  createApprovalSlug,
  normalizeNotifyOutput,
} from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { coerceEnv } from "./bash-tools.shared.js";
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
  commandSecurityConfig?: {
    enabled?: boolean;
    failOpen?: boolean;
    timeoutMs?: number;
    tirithPath?: string;
  };
};

export async function executeNodeHostCommand(
  params: ExecuteNodeHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  const { hostSecurity, hostAsk, askFallback } = resolveExecHostApprovalContext({
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
  let securityWarning = false;
  if (params.commandSecurityConfig?.enabled !== false) {
    const shell = String(nodeInfo?.platform ?? "")
      .toLowerCase()
      .startsWith("win")
      ? "cmd"
      : "posix";
    const tirithExecEnv: Record<string, string> = { ...coerceEnv(process.env) };
    const hostShellPath = getShellPathFromLoginShell({
      env: process.env,
      timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
    });
    if (hostShellPath) {
      tirithExecEnv.PATH = hostShellPath;
    }
    const securityCheck = await checkCommandSecurity(params.command, params.commandSecurityConfig, {
      shell,
      env: tirithExecEnv,
    });
    if (securityCheck.action === "block") {
      throw new Error(`exec denied: command blocked by security scan.\n${securityCheck.summary}`);
    }
    if (securityCheck.action === "warn" && securityCheck.findings.length > 0) {
      securityWarning = true;
      params.warnings.push(`Security: ${securityCheck.summary}`);
    }
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
    }) ||
    obfuscation.detected ||
    securityWarning;
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
        approvalDecision: approvalDecision ?? undefined,
        runId: runId ?? undefined,
        suppressNotifyOnExit: suppressNotifyOnExit === true ? true : undefined,
      },
      idempotencyKey: crypto.randomUUID(),
    }) satisfies Record<string, unknown>;

  if (requiresAsk) {
    const {
      approvalId,
      approvalSlug,
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
    const initiatingSurface = resolveExecApprovalInitiatingSurfaceState({
      channel: params.turnSourceChannel,
      accountId: params.turnSourceAccountId,
    });
    const cfg = loadConfig();
    const sentApproverDms =
      (initiatingSurface.kind === "disabled" || initiatingSurface.kind === "unsupported") &&
      hasConfiguredExecApprovalDmRoute(cfg);
    const unavailableReason =
      preResolvedDecision === null
        ? "no-approval-route"
        : initiatingSurface.kind === "disabled"
          ? "initiating-platform-disabled"
          : initiatingSurface.kind === "unsupported"
            ? "initiating-platform-unsupported"
            : null;

    void (async () => {
      const decision = await resolveApprovalDecisionOrUndefined({
        approvalId,
        preResolvedDecision,
        onFailure: () =>
          void sendExecApprovalFollowup({
            approvalId,
            sessionKey: params.notifySessionKey,
            turnSourceChannel: params.turnSourceChannel,
            turnSourceTo: params.turnSourceTo,
            turnSourceAccountId: params.turnSourceAccountId,
            turnSourceThreadId: params.turnSourceThreadId,
            resultText: `Exec denied (node=${nodeId} id=${approvalId}, approval-request-failed): ${params.command}`,
          }),
      });
      if (decision === undefined) {
        return;
      }

      const baseDecision = resolveBaseExecApprovalDecision({
        decision,
        askFallback,
        obfuscationDetected: obfuscation.detected,
        securityWarning,
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
        await sendExecApprovalFollowup({
          approvalId,
          sessionKey: params.notifySessionKey,
          turnSourceChannel: params.turnSourceChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
          resultText: `Exec denied (node=${nodeId} id=${approvalId}, ${deniedReason}): ${params.command}`,
        }).catch(() => {});
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
        await sendExecApprovalFollowup({
          approvalId,
          sessionKey: params.notifySessionKey,
          turnSourceChannel: params.turnSourceChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
          resultText: summary,
        }).catch(() => {});
      } catch {
        await sendExecApprovalFollowup({
          approvalId,
          sessionKey: params.notifySessionKey,
          turnSourceChannel: params.turnSourceChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
          resultText: `Exec denied (node=${nodeId} id=${approvalId}, invoke-failed): ${params.command}`,
        }).catch(() => {});
      }
    })();

    return {
      content: [
        {
          type: "text",
          text:
            unavailableReason !== null
              ? (buildExecApprovalUnavailableReplyPayload({
                  warningText,
                  reason: unavailableReason,
                  channelLabel: initiatingSurface.channelLabel,
                  sentApproverDms,
                }).text ?? "")
              : buildApprovalPendingMessage({
                  warningText,
                  approvalSlug,
                  approvalId,
                  command: prepared.plan.commandText,
                  cwd: runCwd,
                  host: "node",
                  nodeId,
                }),
        },
      ],
      details:
        unavailableReason !== null
          ? ({
              status: "approval-unavailable",
              reason: unavailableReason,
              channelLabel: initiatingSurface.channelLabel,
              sentApproverDms,
              host: "node",
              command: params.command,
              cwd: params.workdir,
              nodeId,
              warningText,
            } satisfies ExecToolDetails)
          : ({
              status: "approval-pending",
              approvalId,
              approvalSlug,
              expiresAtMs,
              host: "node",
              command: params.command,
              cwd: params.workdir,
              nodeId,
              warningText,
            } satisfies ExecToolDetails),
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
