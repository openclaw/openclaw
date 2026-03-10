import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { loadConfig } from "../config/config.js";
import { buildExecApprovalUnavailableReplyPayload } from "../infra/exec-approval-reply.js";
import {
  hasConfiguredExecApprovalDmRoute,
  resolveExecApprovalInitiatingSurfaceState,
} from "../infra/exec-approval-surface.js";
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
import { markBackgrounded, tail } from "./bash-process-registry.js";
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
            resultText: `Exec denied (gateway id=${approvalId}, approval-request-failed): ${params.command}`,
          }),
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
        await sendExecApprovalFollowup({
          approvalId,
          sessionKey: params.notifySessionKey,
          turnSourceChannel: params.turnSourceChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
          resultText: `Exec denied (gateway id=${approvalId}, ${deniedReason}): ${params.command}`,
        }).catch(() => {});
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
        await sendExecApprovalFollowup({
          approvalId,
          sessionKey: params.notifySessionKey,
          turnSourceChannel: params.turnSourceChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
          resultText: `Exec denied (gateway id=${approvalId}, spawn-failed): ${params.command}`,
        }).catch(() => {});
        return;
      }

      markBackgrounded(run.session);

      const outcome = await run.promise;
      const output = normalizeNotifyOutput(
        tail(outcome.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
      );
      const exitLabel = outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
      const summary = output
        ? `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})\n${output}`
        : `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})`;
      await sendExecApprovalFollowup({
        approvalId,
        sessionKey: params.notifySessionKey,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceTo: params.turnSourceTo,
        turnSourceAccountId: params.turnSourceAccountId,
        turnSourceThreadId: params.turnSourceThreadId,
        resultText: summary,
      }).catch(() => {});
    })();

    return {
      pendingResult: {
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
                    command: params.command,
                    cwd: params.workdir,
                    host: "gateway",
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
                host: "gateway",
                command: params.command,
                cwd: params.workdir,
                warningText,
              } satisfies ExecToolDetails)
            : ({
                status: "approval-pending",
                approvalId,
                approvalSlug,
                expiresAtMs,
                host: "gateway",
                command: params.command,
                cwd: params.workdir,
                warningText,
              } satisfies ExecToolDetails),
      },
    };
  }

  if (hostSecurity === "allowlist" && (!analysisOk || !allowlistSatisfied)) {
    throw new Error("exec denied: allowlist miss");
  }

  recordMatchedAllowlistUse(allowlistEval.segments[0]?.resolution?.resolvedPath);

  return { execCommandOverride: enforcedCommand };
}
