import { redactToolDetail } from "../logging/redact.js";
import { truncateUtf16Safe } from "../utils.js";

const SUBAGENT_PROGRESS_LABEL_MAX_CHARS = 120;
const SUBAGENT_PROGRESS_STATUS_MAX_CHARS = 220;

function sanitizeSubagentProgressText(
  value: string | undefined,
  maxChars: number,
): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  const redacted = redactToolDetail(compact).replace(/\s+/g, " ").trim();
  if (!redacted) {
    return undefined;
  }
  return truncateUtf16Safe(redacted, maxChars);
}

export function sanitizeSubagentProgressLabel(value: string | undefined): string | undefined {
  return sanitizeSubagentProgressText(value, SUBAGENT_PROGRESS_LABEL_MAX_CHARS);
}

export function resolveSubagentProgressLabel(candidates: readonly (string | undefined)[]): string {
  for (const candidate of candidates) {
    const label = sanitizeSubagentProgressLabel(candidate);
    if (label) {
      return label;
    }
  }
  return "Sub-agent";
}

export function buildSubagentProgressSummary(params: {
  label: string | undefined;
  statusLabel: string | undefined;
}): string {
  const label = sanitizeSubagentProgressLabel(params.label) ?? "Sub-agent";
  const status = sanitizeSubagentProgressText(
    params.statusLabel,
    SUBAGENT_PROGRESS_STATUS_MAX_CHARS,
  );
  return status ? `${label}: ${status}` : label;
}
