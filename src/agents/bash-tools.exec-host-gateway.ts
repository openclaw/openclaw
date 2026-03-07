import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { loadConfig } from "../config/config.js";
import {
  addAllowlistEntry,
  type ExecAsk,
  type ExecSecurity,
  buildEnforcedShellCommand,
  evaluateShellAllowlist,
  recordAllowlistUse,
  requiresExecApproval,
  resolveAllowAlwaysPatterns,
} from "../infra/exec-approvals.js";
import { detectCommandObfuscation } from "../infra/exec-obfuscation-detect.js";
import type { SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
import { logInfo } from "../logger.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { markBackgrounded, tail } from "./bash-process-registry.js";
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
  DEFAULT_NOTIFY_TAIL_CHARS,
  createApprovalSlug,
  emitExecSystemEvent,
  normalizeNotifyOutput,
  runExecProcess,
} from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";

export type ProcessGatewayAllowlistParams = {
  command: string;
  workdir: string;
  env: Record<string, string>;
  pty: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  security: ExecSecurity;
  ask: ExecAsk;
  safeBins: Set<string>;
  safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  scopeKey?: string;
  warnings: string[];
  notifySessionKey?: string;
  approvalRunningNoticeMs: number;
  maxOutput: number;
  pendingMaxOutput: number;
  trustedSafeBinDirs?: ReadonlySet<string>;
};

export type ProcessGatewayAllowlistResult = {
  execCommandOverride?: string;
  pendingResult?: AgentToolResult<ExecToolDetails>;
};

/**
 * Checks whether the source channel has interactive (button-based) exec
 * approvals configured.  When active, the agent tool result text should tell
 * the LLM to emit NO_REPLY so the redundant text message is suppressed.
 */
function hasInteractiveExecApprovals(turnSourceChannel?: string): boolean {
  if (!turnSourceChannel) {
    return false;
  }
  const channel = normalizeMessageChannel(turnSourceChannel) ?? turnSourceChannel;
  try {
    const cfg = loadConfig();
    type ChannelCfg = {
      execApprovals?: { enabled?: boolean; approvers?: Array<string | number> };
      accounts?: Record<
        string,
        { execApprovals?: { enabled?: boolean; approvers?: Array<string | number> } }
      >;
    };
    const channelCfg = (cfg.channels as Record<string, unknown> | undefined)?.[channel] as
      | ChannelCfg
      | undefined;
    if (!channelCfg) {
      return false;
    }
    const ea = channelCfg.execApprovals;
    if (ea?.enabled && (ea.approvers?.length ?? 0) > 0) {
      return true;
    }
    if (channelCfg.accounts) {
      return Object.values(channelCfg.accounts).some(
        (acc) => acc.execApprovals?.enabled && (acc.execApprovals.approvers?.length ?? 0) > 0,
      );
    }
    return false;
  } catch {
    return false;
  }
}

export async function processGatewayAllowlist(
  params: ProcessGatewayAllowlistParams,
): Promise<ProcessGatewayAllowlistResult> {
  const { approvals, hostSecurity, hostAsk, askFallback } = resolveExecHostApprovalContext({
    agentId: params.agentId,
    security: params.security,
    ask: params.ask,
    host: "gateway",
  });
  const allowlistEval = evaluateShellAllowlist({
    command: params.command,
    allowlist: approvals.allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.workdir,
    env: params.env,
    platform: process.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
  });
  const allowlistMatches = allowlistEval.allowlistMatches;
  const analysisOk = allowlistEval.analysisOk;
  const allowlistSatisfied =
    hostSecurity === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
  let enforcedCommand: string | undefined;
  if (hostSecurity === "allowlist" && analysisOk && allowlistSatisfied) {
    const enforced = buildEnforcedShellCommand({
      command: params.command,
      segments: allowlistEval.segments,
      platform: process.platform,
    });
    if (!enforced.ok || !enforced.command) {
      throw new Error(`exec denied: allowlist execution plan unavailable (${enforced.reason})`);
    }
    enforcedCommand = enforced.command;
  }
  const obfuscation = detectCommandObfuscation(params.command);
  if (obfuscation.detected) {
    logInfo(`exec: obfuscation detected (gateway): ${obfuscation.reasons.join(", ")}`);
    params.warnings.push(`⚠️ Obfuscated command detected: ${obfuscation.reasons.join("; ")}`);
  }
  const recordMatchedAllowlistUse = (resolvedPath?: string) => {
    if (allowlistMatches.length === 0) {
      return;
    }
    const seen = new Set<string>();
    for (const match of allowlistMatches) {
      if (seen.has(match.pattern)) {
        continue;
      }
      seen.add(match.pattern);
      recordAllowlistUse(approvals.file, params.agentId, match, params.command, resolvedPath);
    }
  };
  const hasHeredocSegment = allowlistEval.segments.some((segment) =>
    segment.argv.some((token) => token.startsWith("<<")),
  );
  const requiresHeredocApproval =
    hostSecurity === "allowlist" && analysisOk && allowlistSatisfied && hasHeredocSegment;
  const requiresAsk =
    requiresExecApproval({
      ask: hostAsk,
      security: hostSecurity,
      analysisOk,
      allowlistSatisfied,
    }) ||
    requiresHeredocApproval ||
    obfuscation.detected;
  if (requiresHeredocApproval) {
    params.warnings.push(
      "Warning: heredoc execution requires explicit approval in allowlist mode.",
    );
  }

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
    const resolvedPath = allowlistEval.segments[0]?.resolution?.resolvedPath;
    const effectiveTimeout =
      typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec;
    let expiresAtMs = defaultExpiresAtMs;
    let preResolvedDecision = defaultPreResolvedDecision;

    // Register first so the returned approval ID is actionable immediately.
    const registration = await registerExecApprovalRequestForHostOrThrow({
      approvalId,
      command: params.command,
      workdir: params.workdir,
      host: "gateway",
      security: hostSecurity,
      ask: hostAsk,
      ...buildExecApprovalRequesterContext({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      }),
      resolvedPath,
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
            `Exec denied (gateway id=${approvalId}, approval-request-failed): ${params.command}`,
            {
              sessionKey: params.notifySessionKey,
              contextKey,
            },
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
      let deniedReason = baseDecision.deniedReason;

      if (baseDecision.timedOut && askFallback === "allowlist") {
        if (!analysisOk || !allowlistSatisfied) {
          deniedReason = "approval-timeout (allowlist-miss)";
        } else {
          approvedByAsk = true;
        }
      } else if (decision === "allow-once") {
        approvedByAsk = true;
      } else if (decision === "allow-always") {
        approvedByAsk = true;
        if (hostSecurity === "allowlist") {
          const patterns = resolveAllowAlwaysPatterns({
            segments: allowlistEval.segments,
            cwd: params.workdir,
            env: params.env,
            platform: process.platform,
          });
          for (const pattern of patterns) {
            if (pattern) {
              addAllowlistEntry(approvals.file, params.agentId, pattern);
            }
          }
        }
      }

      if (hostSecurity === "allowlist" && (!analysisOk || !allowlistSatisfied) && !approvedByAsk) {
        deniedReason = deniedReason ?? "allowlist-miss";
      }

      if (deniedReason) {
        emitExecSystemEvent(
          `Exec denied (gateway id=${approvalId}, ${deniedReason}): ${params.command}`,
          {
            sessionKey: params.notifySessionKey,
            contextKey,
          },
        );
        return;
      }

      recordMatchedAllowlistUse(resolvedPath ?? undefined);

      let run: Awaited<ReturnType<typeof runExecProcess>> | null = null;
      try {
        run = await runExecProcess({
          command: params.command,
          execCommand: enforcedCommand,
          workdir: params.workdir,
          env: params.env,
          sandbox: undefined,
          containerWorkdir: null,
          usePty: params.pty,
          warnings: params.warnings,
          maxOutput: params.maxOutput,
          pendingMaxOutput: params.pendingMaxOutput,
          notifyOnExit: false,
          notifyOnExitEmptySuccess: false,
          scopeKey: params.scopeKey,
          sessionKey: params.notifySessionKey,
          timeoutSec: effectiveTimeout,
        });
      } catch {
        emitExecSystemEvent(
          `Exec denied (gateway id=${approvalId}, spawn-failed): ${params.command}`,
          {
            sessionKey: params.notifySessionKey,
            contextKey,
          },
        );
        return;
      }

      markBackgrounded(run.session);

      let runningTimer: NodeJS.Timeout | null = null;
      if (params.approvalRunningNoticeMs > 0) {
        runningTimer = setTimeout(() => {
          emitExecSystemEvent(
            `Exec running (gateway id=${approvalId}, session=${run?.session.id}, >${noticeSeconds}s): ${params.command}`,
            { sessionKey: params.notifySessionKey, contextKey },
          );
        }, params.approvalRunningNoticeMs);
      }

      const outcome = await run.promise;
      if (runningTimer) {
        clearTimeout(runningTimer);
      }
      const output = normalizeNotifyOutput(
        tail(outcome.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
      );
      const exitLabel = outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
      const summary = output
        ? `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})\n${output}`
        : `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})`;
      emitExecSystemEvent(summary, { sessionKey: params.notifySessionKey, contextKey });
    })();

    const interactiveApprovals = hasInteractiveExecApprovals(params.turnSourceChannel);
    const pendingText = interactiveApprovals
      ? `${warningText}Approval required (id ${approvalSlug}). ` +
        `An interactive approval prompt with buttons has been sent to the user — ` +
        `do not repeat the command or approval details. ` +
        `The command will execute automatically once approved. ` +
        `You will receive a system notification with the result — report it to the user at that time.`
      : `${warningText}Approval required (id ${approvalSlug}). ` +
        "Approve to run; updates will arrive after completion.";

    return {
      pendingResult: {
        content: [
          {
            type: "text",
            text: pendingText,
          },
        ],
        details: {
          status: "approval-pending",
          approvalId,
          approvalSlug,
          expiresAtMs,
          host: "gateway",
          command: params.command,
          cwd: params.workdir,
        },
      },
    };
  }

  if (hostSecurity === "allowlist" && (!analysisOk || !allowlistSatisfied)) {
    throw new Error("exec denied: allowlist miss");
  }

  recordMatchedAllowlistUse(allowlistEval.segments[0]?.resolution?.resolvedPath);

  return { execCommandOverride: enforcedCommand };
}
