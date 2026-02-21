import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  addAllowlistEntry,
  type ExecAsk,
  type ExecSecurity,
  buildSafeBinsShellCommand,
  buildSafeShellCommand,
  evaluateShellAllowlist,
  maxAsk,
  minSecurity,
  recordAllowlistUse,
  requiresExecApproval,
  resolveExecApprovals,
} from "../infra/exec-approvals.js";
import { markBackgrounded, tail } from "./bash-process-registry.js";
import { requestExecApprovalDecision } from "./bash-tools.exec-approval-request.js";
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
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
  agentId?: string;
  sessionKey?: string;
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
  const approvals = resolveExecApprovals(params.agentId, {
    security: params.security,
    ask: params.ask,
  });
  const hostSecurity = minSecurity(params.security, approvals.agent.security);
  const hostAsk = maxAsk(params.ask, approvals.agent.ask);
  const askFallback = approvals.agent.askFallback;
  if (hostSecurity === "deny") {
    throw new Error("exec denied: host=gateway security=deny");
  }
  const allowlistEval = evaluateShellAllowlist({
    command: params.command,
    allowlist: approvals.allowlist,
    safeBins: params.safeBins,
    cwd: params.workdir,
    env: params.env,
    platform: process.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
  });
  const allowlistMatches = allowlistEval.allowlistMatches;
  const analysisOk = allowlistEval.analysisOk;
  const allowlistSatisfied =
    hostSecurity === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
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
    }) || requiresHeredocApproval;
  if (requiresHeredocApproval) {
    params.warnings.push(
      "Warning: heredoc execution requires explicit approval in allowlist mode.",
    );
  }

  if (requiresAsk) {
    const approvalId = crypto.randomUUID();
    const approvalSlug = createApprovalSlug(approvalId);
    const expiresAtMs = Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
    const contextKey = `exec:${approvalId}`;
    const resolvedPath = allowlistEval.segments[0]?.resolution?.resolvedPath;
    const noticeSeconds = Math.max(1, Math.round(params.approvalRunningNoticeMs / 1000));
    const effectiveTimeout =
      typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec;
    const warningText = params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "";

    void (async () => {
      let decision: string | null = null;
      try {
        decision = await requestExecApprovalDecision({
          id: approvalId,
          command: params.command,
          cwd: params.workdir,
          host: "gateway",
          security: hostSecurity,
          ask: hostAsk,
          agentId: params.agentId,
          resolvedPath,
          sessionKey: params.sessionKey,
        });
      } catch {
        emitExecSystemEvent(
          `Exec denied (gateway id=${approvalId}, approval-request-failed): ${params.command}`,
          {
            sessionKey: params.notifySessionKey,
            contextKey,
          },
        );
        return;
      }

      let approvedByAsk = false;
      let deniedReason: string | null = null;

      if (decision === "deny") {
        deniedReason = "user-denied";
      } else if (!decision) {
        if (askFallback === "full") {
          approvedByAsk = true;
        } else if (askFallback === "allowlist") {
          if (!analysisOk || !allowlistSatisfied) {
            deniedReason = "approval-timeout (allowlist-miss)";
          } else {
            approvedByAsk = true;
          }
        } else {
          deniedReason = "approval-timeout";
        }
      } else if (decision === "allow-once") {
        approvedByAsk = true;
      } else if (decision === "allow-always") {
        approvedByAsk = true;
        if (hostSecurity === "allowlist") {
          for (const segment of allowlistEval.segments) {
            const pattern = segment.resolution?.resolvedPath ?? "";
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

      if (allowlistMatches.length > 0) {
        const seen = new Set<string>();
        for (const match of allowlistMatches) {
          if (seen.has(match.pattern)) {
            continue;
          }
          seen.add(match.pattern);
          recordAllowlistUse(
            approvals.file,
            params.agentId,
            match,
            params.command,
            resolvedPath ?? undefined,
          );
        }
      }

      let run: Awaited<ReturnType<typeof runExecProcess>> | null = null;
      try {
        run = await runExecProcess({
          command: params.command,
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

    return {
      pendingResult: {
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

  let execCommandOverride: string | undefined;
  // If allowlist uses safeBins, sanitize only those stdin-only segments:
  // disable glob/var expansion by forcing argv tokens to be literal via single-quoting.
  if (
    hostSecurity === "allowlist" &&
    analysisOk &&
    allowlistSatisfied &&
    allowlistEval.segmentSatisfiedBy.some((by) => by === "safeBins")
  ) {
    const safe = buildSafeBinsShellCommand({
      command: params.command,
      segments: allowlistEval.segments,
      segmentSatisfiedBy: allowlistEval.segmentSatisfiedBy,
      platform: process.platform,
    });
    if (!safe.ok || !safe.command) {
      // Fallback: quote everything (safe, but may change glob behavior).
      const fallback = buildSafeShellCommand({
        command: params.command,
        platform: process.platform,
      });
      if (!fallback.ok || !fallback.command) {
        throw new Error(`exec denied: safeBins sanitize failed (${safe.reason ?? "unknown"})`);
      }
      params.warnings.push(
        "Warning: safeBins hardening used fallback quoting due to parser mismatch.",
      );
      execCommandOverride = fallback.command;
    } else {
      params.warnings.push(
        "Warning: safeBins hardening disabled glob/variable expansion for stdin-only segments.",
      );
      execCommandOverride = safe.command;
    }
  }

  if (allowlistMatches.length > 0) {
    const seen = new Set<string>();
    for (const match of allowlistMatches) {
      if (seen.has(match.pattern)) {
        continue;
      }
      seen.add(match.pattern);
      recordAllowlistUse(
        approvals.file,
        params.agentId,
        match,
        params.command,
        allowlistEval.segments[0]?.resolution?.resolvedPath,
      );
    }
  }

  return { execCommandOverride };
}
