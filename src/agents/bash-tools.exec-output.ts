/**
 * Rendering helpers for exec output/status updates.
 * Keeps no-output placeholders and warning placement consistent across exec
 * progress, polling, and completion surfaces.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { TerminationReason } from "../process/supervisor/types.js";

export const EXEC_NO_OUTPUT_PLACEHOLDER = "(no output)";
// Keep launch and later process observations consistent without naming an aliased tool.
export const EXEC_MANUAL_COLLECTION_FOLLOW_UP =
  "Automatic completion wake is disabled (tools.exec.notifyOnExit=false). If the task needs this result, use poll with a timeout to collect it before ending the turn, unless another continuation is already arranged.";
export const EXEC_TIMEOUT_RETRY_GUIDANCE =
  "The command was terminated, but external side effects may already have completed. Verify the resulting state before retrying. Do not automatically rerun commands unless repeating them is safe. Use a higher timeout only when the command is known to be safe to retry.";

// Irreversible loss leads model-visible output so later head-preserving caps retain it.
export const EXEC_RETENTION_CAP_NOTE =
  "[earlier output was discarded at the retention cap and cannot be recovered]\n\n";

/** Render command output with a stable placeholder for empty output. */
export function renderExecOutputText(value: string | undefined): string {
  return value || EXEC_NO_OUTPUT_PLACEHOLDER;
}

/** Render the authoritative process exit without inventing a successful code. */
export function renderExecExitLabel(exit: {
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
}): string {
  if (exit.exitSignal != null) {
    return `signal ${exit.exitSignal}`;
  }
  return typeof exit.exitCode === "number" ? `code ${exit.exitCode}` : "unknown exit code";
}

/** Render the text shown in exec progress updates, including warnings first. */
export function renderExecUpdateText(params: { tailText?: string; warnings: string[] }): string {
  const warningText = params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "";
  return warningText + renderExecOutputText(params.tailText);
}

/** Add retry-safety guidance only for supervisor timeout exits. */
export function appendExecTimeoutRetryGuidance(
  text: string,
  exitReason: TerminationReason | undefined,
): string {
  if (exitReason !== "overall-timeout" && exitReason !== "no-output-timeout") {
    return text;
  }
  return `${text}\n\n${EXEC_TIMEOUT_RETRY_GUIDANCE}`;
}

const DEFAULT_NOTIFY_SNIPPET_CHARS = 180;

/** Normalizes notification snippets to a compact single-line form. */
export function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function compactNotifyOutput(value: string, maxChars = DEFAULT_NOTIFY_SNIPPET_CHARS) {
  const normalized = normalizeNotifyOutput(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const safe = Math.max(1, maxChars - 1);
  return `${truncateUtf16Safe(normalized, safe)}…`;
}
