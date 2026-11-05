import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { ExecAllowlistAnalysis } from "../infra/exec-approvals-allowlist.js";
import type { ExecAutoReviewDecision } from "../infra/exec-auto-review.js";
import { tail } from "./bash-process-registry.js";
import { formatExecApprovalContinuationSourceOutput } from "./bash-tools.exec-approval-output.js";
import type { ProcessGatewayAllowlistParams } from "./bash-tools.exec-host-gateway.types.js";
import { appendExecTimeoutRetryGuidance, normalizeNotifyOutput } from "./bash-tools.exec-output.js";
import type {
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
  ExecToolDetails,
  ExecToolApprovalReview,
} from "./bash-tools.exec-types.js";
import { formatExecDeniedReasonMessage } from "./exec-approval-result.js";
import type { AgentToolResult } from "./runtime/index.js";

function formatBytes(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.max(0, Math.round(value))} bytes`;
}

function formatDiagnosticsExportSuccess(aggregated: string): string {
  const trimmed = aggregated.trim();
  if (!trimmed) {
    return "Diagnostics export completed, but no JSON output was returned.";
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return trimmed;
    }
    const manifest = isRecord(parsed.manifest) ? parsed.manifest : {};
    const lines = ["Diagnostics export created.", "", "Local Gateway bundle:"];
    const bundlePath = typeof parsed.path === "string" ? parsed.path : "";
    if (bundlePath) {
      lines.push(`Path: ${bundlePath}`);
    }
    const bytes = formatBytes(parsed.bytes);
    if (bytes) {
      lines.push(`Size: ${bytes}`);
    }
    if (typeof manifest.generatedAt === "string") {
      lines.push(`Generated at: ${manifest.generatedAt}`);
    }
    if (typeof manifest.openclawVersion === "string") {
      lines.push(`OpenClaw version: ${manifest.openclawVersion}`);
    }
    const contents = Array.isArray(manifest.contents) ? manifest.contents : [];
    if (contents.length > 0) {
      lines.push("", `Contents (${contents.length} files):`);
      for (const entry of contents.slice(0, 12)) {
        if (!isRecord(entry)) {
          continue;
        }
        const path = typeof entry.path === "string" ? entry.path : "";
        if (!path) {
          continue;
        }
        const entryBytes = formatBytes(entry.bytes);
        lines.push(`- ${entryBytes ? `${path} (${entryBytes})` : path}`);
      }
      if (contents.length > 12) {
        lines.push(`- ... ${contents.length - 12} more`);
      }
    }
    const privacy = isRecord(manifest.privacy) ? manifest.privacy : null;
    if (privacy) {
      const privacyLines = ["Privacy:"];
      if (typeof privacy.payloadFree === "boolean") {
        privacyLines.push(`- payload-free: ${privacy.payloadFree ? "yes" : "no"}`);
      }
      if (typeof privacy.rawLogsIncluded === "boolean") {
        privacyLines.push(`- raw logs included: ${privacy.rawLogsIncluded ? "yes" : "no"}`);
      }
      const notes = Array.isArray(privacy.notes)
        ? privacy.notes.filter((note): note is string => typeof note === "string")
        : [];
      for (const note of notes.slice(0, 4)) {
        privacyLines.push(`- ${note}`);
      }
      if (privacyLines.length > 1) {
        lines.push("", ...privacyLines);
      }
    }
    return lines.join("\n");
  } catch {
    return trimmed;
  }
}

export function buildGatewayExecApprovalFollowupSummary(params: {
  approvalId: string;
  sessionId: string;
  outcome: ExecApprovalFollowupOutcome;
  trigger?: string;
  approvalFollowupText?: string;
}): string {
  const exitLabel = params.outcome.timedOut ? "timeout" : `code ${params.outcome.exitCode ?? "?"}`;
  let summary: string;
  if (params.trigger === "diagnostics") {
    let diagnosticsText: string;
    if (params.outcome.status === "completed" && params.outcome.exitCode === 0) {
      diagnosticsText = formatDiagnosticsExportSuccess(params.outcome.aggregated);
    } else {
      const output = normalizeNotifyOutput(tail(params.outcome.aggregated || "", 4000));
      const lines = [`Diagnostics export failed (${exitLabel}).`];
      if (params.outcome.reason) {
        lines.push(params.outcome.reason);
      }
      if (output) {
        lines.push("", output);
      }
      diagnosticsText = lines.join("\n");
    }
    const followupText = params.approvalFollowupText?.trim();
    const body = [diagnosticsText, followupText].filter(Boolean).join("\n\n");
    summary = `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})\n${body}`;
  } else {
    const output = formatExecApprovalContinuationSourceOutput([
      { label: "output", value: params.outcome.aggregated },
    ]);
    summary = output
      ? `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})\n${output}`
      : `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})`;
  }
  return appendExecTimeoutRetryGuidance(summary, params.outcome.exitReason);
}

export function buildGatewayExecAllowlistDeniedMessage(evaluation: ExecAllowlistAnalysis): string {
  const unresolved = evaluation.authorizationPlan?.groups
    .flatMap((group) => group.candidates)
    .some(
      ({ trustMode, sourceSegment: { resolution } }, index) =>
        trustMode === "executable" &&
        evaluation.segmentSatisfiedBy[index] === null &&
        resolution !== null &&
        !resolution.execution.resolvedPath,
    );
  return unresolved
    ? "exec denied: executable could not be resolved; check command spelling and Gateway PATH or use an absolute executable path"
    : "exec denied: allowlist miss";
}

export function buildGatewayExecApprovalDeniedToolResult(params: {
  approvalId?: string;
  deniedReason: string;
  command: string;
  cwd: string;
}): AgentToolResult<ExecToolDetails> {
  const denialContext = params.approvalId
    ? `gateway id=${params.approvalId}, ${params.deniedReason}`
    : params.deniedReason;
  const text = `Exec denied (${denialContext}): ${params.command}\n${formatExecDeniedReasonMessage(params.deniedReason)}`;
  return {
    content: [{ type: "text", text }],
    details: {
      status: "failed",
      exitCode: null,
      durationMs: 0,
      aggregated: text,
      timedOut: params.deniedReason.includes("timeout"),
      cwd: params.cwd,
    },
  };
}

export async function resolveGatewayExecApprovalFollowupText(params: {
  approvalFollowup?: ExecApprovalFollowupFactory;
  approvalId: string;
  sessionId: string;
  trigger?: string;
  outcome: ExecApprovalFollowupOutcome;
}): Promise<string | undefined> {
  if (!params.approvalFollowup) {
    return undefined;
  }
  try {
    return await params.approvalFollowup({
      approvalId: params.approvalId,
      sessionId: params.sessionId,
      trigger: params.trigger,
      outcome: params.outcome,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Diagnostics follow-up failed: ${message}`;
  }
}

export function publishGatewayGuardianReview(
  params: ProcessGatewayAllowlistParams,
  status: ExecToolApprovalReview["status"],
  decision?: ExecAutoReviewDecision,
): void {
  if (!params.toolCallId) {
    return;
  }
  const approvalReviewOutcome =
    status === "in_progress" ? "reviewing" : status === "approved" ? "approved" : "denied";
  const review: ExecToolApprovalReview = {
    id: `guardian:${params.toolCallId}`,
    label: "Guardian",
    status,
    ...(decision ? { riskLevel: decision.risk, rationale: decision.rationale } : {}),
  };
  // Preserve terminal evidence before synchronous listeners can change reviewed operands.
  if (status !== "in_progress") {
    params.onApprovalReview?.(review);
  }
  if (!params.runId) {
    return;
  }
  emitAgentEvent({
    runId: params.runId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    stream: "tool",
    data: {
      phase: "review",
      name: "exec",
      toolCallId: params.toolCallId,
      hideFromChannelProgress: true,
      approvalReviewOutcome,
      review,
    },
  });
}
