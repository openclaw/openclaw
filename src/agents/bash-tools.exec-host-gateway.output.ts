import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tail } from "./bash-process-registry.js";
import { formatExecApprovalContinuationSourceOutput } from "./bash-tools.exec-approval-output.js";
import { appendExecTimeoutRetryGuidance, normalizeNotifyOutput } from "./bash-tools.exec-output.js";
import type {
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

function formatOutcomeExitLabel(outcome: { exitCode: number | null; timedOut: boolean }): string {
  return outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
}

function formatBytes(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.max(0, Math.round(value))} bytes`;
}

function formatDiagnosticsContents(manifest: Record<string, unknown>): string[] {
  const contents = Array.isArray(manifest.contents) ? manifest.contents : [];
  if (contents.length === 0) {
    return [];
  }
  const lines = [`Contents (${contents.length} files):`];
  for (const entry of contents.slice(0, 12)) {
    if (!isRecord(entry)) {
      continue;
    }
    const path = typeof entry.path === "string" ? entry.path : "";
    if (!path) {
      continue;
    }
    const bytes = formatBytes(entry.bytes);
    lines.push(`- ${bytes ? `${path} (${bytes})` : path}`);
  }
  if (contents.length > 12) {
    lines.push(`- ... ${contents.length - 12} more`);
  }
  return lines;
}

function formatDiagnosticsPrivacy(manifest: Record<string, unknown>): string[] {
  const privacy = isRecord(manifest.privacy) ? manifest.privacy : null;
  if (!privacy) {
    return [];
  }
  const lines = ["Privacy:"];
  if (typeof privacy.payloadFree === "boolean") {
    lines.push(`- payload-free: ${privacy.payloadFree ? "yes" : "no"}`);
  }
  if (typeof privacy.rawLogsIncluded === "boolean") {
    lines.push(`- raw logs included: ${privacy.rawLogsIncluded ? "yes" : "no"}`);
  }
  const notes = Array.isArray(privacy.notes)
    ? privacy.notes.filter((note): note is string => typeof note === "string")
    : [];
  for (const note of notes.slice(0, 4)) {
    lines.push(`- ${note}`);
  }
  return lines.length > 1 ? lines : [];
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
    const contents = formatDiagnosticsContents(manifest);
    if (contents.length > 0) {
      lines.push("", ...contents);
    }
    const privacy = formatDiagnosticsPrivacy(manifest);
    if (privacy.length > 0) {
      lines.push("", ...privacy);
    }
    return lines.join("\n");
  } catch {
    return trimmed;
  }
}

function formatDiagnosticsExportFailure(params: {
  outcome: { status: string; reason?: string; aggregated: string };
  exitLabel: string;
}): string {
  const output = normalizeNotifyOutput(tail(params.outcome.aggregated || "", 4000));
  const lines = [`Diagnostics export failed (${params.exitLabel}).`];
  if (params.outcome.reason) {
    lines.push(params.outcome.reason);
  }
  if (output) {
    lines.push("", output);
  }
  return lines.join("\n");
}

export function buildGatewayExecApprovalFollowupSummary(params: {
  approvalId: string;
  sessionId: string;
  outcome: ExecApprovalFollowupOutcome;
  trigger?: string;
  approvalFollowupText?: string;
}): string {
  const exitLabel = formatOutcomeExitLabel(params.outcome);
  let summary: string;
  if (params.trigger === "diagnostics") {
    const diagnosticsText =
      params.outcome.status === "completed" && params.outcome.exitCode === 0
        ? formatDiagnosticsExportSuccess(params.outcome.aggregated)
        : formatDiagnosticsExportFailure({ outcome: params.outcome, exitLabel });
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

export function buildGatewayExecApprovalDeniedToolResult(params: {
  approvalId?: string;
  deniedReason: string;
  command: string;
  cwd: string;
}): AgentToolResult<ExecToolDetails> {
  const denialContext = params.approvalId
    ? `gateway id=${params.approvalId}, ${params.deniedReason}`
    : params.deniedReason;
  const text = `Exec denied (${denialContext}): ${params.command}`;
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
