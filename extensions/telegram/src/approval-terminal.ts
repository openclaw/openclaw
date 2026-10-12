import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type {
  ExpiredApprovalView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  buildSystemAgentApprovalResolvedText,
  formatApprovalDecisionLabel,
} from "openclaw/plugin-sdk/approval-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const TELEGRAM_APPROVAL_DETAIL_MAX_CHARS = 2_800;
const TELEGRAM_APPROVAL_ID_MAX_CHARS = 512;
const TELEGRAM_APPROVAL_TERMINAL_MAX_CHARS = 4_000;

function formatApprovalDecision(decision: ResolvedApprovalView["decision"] | undefined): string {
  return decision ? formatApprovalDecisionLabel(decision) : "Resolved";
}

function formatCanonicalResult(approval: ApprovalResolveResult["approval"]): string {
  if (approval.status === "allowed" || approval.status === "denied") {
    return formatApprovalDecision(approval.decision);
  }
  return approval.status === "expired" ? "Expired" : "Cancelled";
}

function truncateApprovalText(value: string, maxChars: number, preserveWhitespace = false): string {
  if (value.length <= maxChars) {
    return value;
  }
  const prefix = truncateUtf16Safe(value, maxChars - 1);
  return `${preserveWhitespace ? prefix : prefix.trimEnd()}…`;
}

function truncateDetail(value: string): string {
  return truncateApprovalText(value.trim(), TELEGRAM_APPROVAL_DETAIL_MAX_CHARS);
}

function truncateApprovalId(value: string): string {
  // Approval ids may contain path-safe Unicode that is still unsafe as a chat line.
  // JSON escaping keeps the receipt single-line without changing ordinary ids.
  return truncateApprovalText(
    JSON.stringify(value).slice(1, -1),
    TELEGRAM_APPROVAL_ID_MAX_CHARS,
    true,
  );
}

function finalizeTerminalText(lines: string[]): string {
  return truncateApprovalText(lines.join("\n"), TELEGRAM_APPROVAL_TERMINAL_MAX_CHARS);
}

function appendApprovalSubject(
  lines: string[],
  label: "Command:" | "Request:",
  subject: string,
  description?: string,
): void {
  lines.push("", label, truncateDetail(subject));
  if (description) {
    lines.push(truncateDetail(description));
  }
}

/** Render the canonical first-answer result returned to a Telegram callback surface. */
export function buildTelegramCanonicalApprovalTerminalText(params: {
  result: ApprovalResolveResult;
  fallbackApprovalId: string;
}): string {
  const approval = params.result.approval;
  if (approval.presentation?.kind === "system-agent" && params.result.applied) {
    if (approval.status === "allowed") {
      return `✅ OpenClaw change approved. Applying: ${truncateDetail(approval.presentation.description)}`;
    }
    return {
      cancelled:
        "⚠️ OpenClaw change was cancelled because its run ended. No change was made. Retry.",
      denied: "❌ OpenClaw change denied. No change was made.",
      expired: "⏱️ OpenClaw change expired. No change was made.",
    }[approval.status];
  }
  const approvalId = approval.id || params.fallbackApprovalId;
  const lines = [
    params.result.applied ? "✅ Approval resolved here" : "ℹ️ Approval already resolved",
    `Canonical result: ${formatCanonicalResult(approval)}`,
    `ID: ${truncateApprovalId(approvalId)}`,
  ];
  if (approval.presentation) {
    const subject = approval.presentation;
    appendApprovalSubject(
      lines,
      subject.kind === "exec" ? "Command:" : "Request:",
      subject.kind === "exec" ? (subject.commandPreview ?? subject.commandText) : subject.title,
      subject.kind === "exec" ? undefined : subject.description.trim(),
    );
  }
  return finalizeTerminalText(lines);
}

/** Render a truthful receipt for a legacy callback without a canonical snapshot. */
export function buildTelegramLegacyApprovalTerminalText(params: {
  approvalId: string;
  decision?: "allow-once" | "allow-always" | "deny";
  outcome: "resolved-here" | "no-longer-pending" | "not-actionable";
}): string {
  const lines =
    params.outcome === "resolved-here"
      ? ["✅ Approval resolved here", `Result: ${formatApprovalDecision(params.decision)}`]
      : params.outcome === "no-longer-pending"
        ? [
            "ℹ️ Approval no longer pending",
            "It was already resolved or expired; the canonical decision is unavailable here.",
          ]
        : [
            "ℹ️ Approval is no longer actionable from this button",
            "It may have been resolved, expired, or require a different authorized approval surface.",
          ];
  lines.push(`ID: ${truncateApprovalId(params.approvalId)}`);
  return finalizeTerminalText(lines);
}

/** Render a neutral terminal receipt for malformed callbacks in the reserved namespace. */
export function buildTelegramInvalidApprovalTerminalText(): string {
  return "ℹ️ Approval action unavailable\nThis button is invalid or no longer actionable.";
}

/** Render a canonical native resolved event while retaining safe request context. */
export function buildTelegramNativeResolvedApprovalText(view: ResolvedApprovalView): string {
  if (view.approvalKind === "system-agent") {
    return buildSystemAgentApprovalResolvedText({
      ...view,
      operationSummary: truncateDetail(view.operationSummary),
    });
  }
  const label = view.approvalKind === "exec" ? "Exec" : "Plugin";
  const lines = [
    `✅ ${label} approval resolved`,
    `Canonical result: ${formatApprovalDecision(view.decision)}`,
  ];
  if (view.resolvedBy?.trim()) {
    lines.push(`Resolved by: ${truncateDetail(view.resolvedBy.replace(/\s+/gu, " "))}`);
  }
  return finalizeNativeApprovalText(view, lines);
}

/** Render a canonical native expiration event while retaining safe request context. */
export function buildTelegramNativeExpiredApprovalText(view: ExpiredApprovalView): string {
  if (view.approvalKind === "system-agent") {
    return "⏱️ OpenClaw change expired. No change was made.";
  }
  const label = view.approvalKind === "exec" ? "Exec" : "Plugin";
  const lines = [`⏱️ ${label} approval expired`, "Canonical result: Expired"];
  return finalizeNativeApprovalText(view, lines);
}

function finalizeNativeApprovalText(
  view: Exclude<ResolvedApprovalView | ExpiredApprovalView, { approvalKind: "system-agent" }>,
  lines: string[],
): string {
  lines.push(`ID: ${truncateApprovalId(view.approvalId)}`);
  appendApprovalSubject(
    lines,
    view.approvalKind === "exec" ? "Command:" : "Request:",
    view.approvalKind === "exec" ? (view.commandPreview ?? view.commandText) : view.title,
    view.approvalKind === "exec" ? undefined : view.description?.trim(),
  );
  return finalizeTerminalText(lines);
}
