import { truncateUtf16Safe } from "../utils.js";
// Builds task status summaries and formatted status text for user-facing surfaces.
import { renderUserFacingText } from "./embedded-agent-helpers/user-facing-text.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";

/** Applies a task display limit to text that its caller has already sanitized. */
function truncateRunStatusText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stripInlineLeakedInternalContext(value: string): string {
  // Completion text can accidentally include hidden runtime context; strip it before status output.
  const beginIndex = value.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN);
  if (
    beginIndex !== -1 &&
    (value.includes(INTERNAL_RUNTIME_CONTEXT_END) ||
      value.includes("OpenClaw runtime context (internal):") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, beginIndex);
  }
  const legacyHeaderIndex = value.indexOf("OpenClaw runtime context (internal):");
  if (
    legacyHeaderIndex !== -1 &&
    (value.includes("Keep internal details private.") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, legacyHeaderIndex);
  }
  return value;
}

function sanitizeRunStatusValue(value: unknown, errorContext: boolean): unknown {
  if (typeof value === "string") {
    const sanitized = renderUserFacingText(stripInlineLeakedInternalContext(value), {
      errorContext,
    })
      .replace(/\s+/g, " ")
      .trim();
    return sanitized || undefined;
  }
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => sanitizeRunStatusValue(entry, errorContext))
      .filter((entry) => entry !== undefined);
    return next.length > 0 ? next : undefined;
  }
  if (value && typeof value === "object") {
    const nextEntries = Object.entries(value)
      .map(([key, entry]) => [key, sanitizeRunStatusValue(entry, errorContext)] as const)
      .filter(([, entry]) => entry !== undefined);
    if (nextEntries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(nextEntries);
  }
  return value;
}

export function sanitizeRunStatusText(
  value: unknown,
  opts?: { errorContext?: boolean; maxChars?: number },
): string {
  const errorContext = opts?.errorContext ?? false;
  const sanitizedValue = sanitizeRunStatusValue(value, errorContext);
  const raw =
    typeof sanitizedValue === "string"
      ? sanitizedValue
      : sanitizedValue == null
        ? ""
        : (JSON.stringify(sanitizedValue) ?? "");
  const sanitized = raw.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return "";
  }
  if (typeof opts?.maxChars === "number") {
    return truncateRunStatusText(sanitized, opts.maxChars);
  }
  return sanitized;
}
