import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const EXEC_COMPLETED_RE = /^exec completed:\s*([\s\S]*)$/i;
const EXEC_METADATA_PREFIXES = [
  ["denied", "exec denied (", ":"],
  ["finished", "exec finished (", "\n"],
  ["outcome-unknown", "exec outcome unknown (", "\n"],
  ["not-dispatched", "exec not dispatched (", "\n"],
] as const;
const EXEC_METADATA_PREFIX_MAX_LENGTH = Math.max(
  ...EXEC_METADATA_PREFIXES.map(([, prefix]) => prefix.length),
);

// Approval-system-generated wrappers always start with either `gateway id=` or
// `node=` inside the parenthesized metadata (see bash-tools.exec-host-gateway.ts,
// bash-tools.exec-host-node.ts, and gateway/server-node-events.ts). Untrusted
// command stdout that happens to start with "Exec denied (...)" or
// "Exec finished (...)" should be rejected by the parser to prevent CWE-841
// spoofed approval events from arbitrary tool output.
const APPROVAL_METADATA_SOURCE_RE = /^(?:gateway\s+id=|node=)/i;

function parseExecApprovalResultWithMetadata(
  raw: string,
  metadataStart: number,
  bodySeparator: ":" | "\n",
): { metadata: string; body: string } | null {
  let depth = 1;
  let metadataEnd = -1;
  for (let index = metadataStart; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        metadataEnd = index;
        break;
      }
    }
  }

  if (metadataEnd < 0) {
    return null;
  }

  const metadata = raw.slice(metadataStart, metadataEnd).trim();
  if (!APPROVAL_METADATA_SOURCE_RE.test(metadata)) {
    return null;
  }

  const remainder = raw.slice(metadataEnd + 1);
  if (!remainder.startsWith(bodySeparator) && (bodySeparator === ":" || remainder)) {
    return null;
  }

  return {
    metadata,
    body: remainder.slice(1).trim(),
  };
}

export function parseExecApprovalResultText(resultText: string) {
  const raw = resultText.trim();
  if (!raw) {
    return { kind: "other" as const, raw };
  }

  // Only the fixed wrapper prefix is case-insensitive, never the command output.
  const normalizedPrefix = raw.slice(0, EXEC_METADATA_PREFIX_MAX_LENGTH).toLowerCase();
  for (const [kind, prefix, separator] of EXEC_METADATA_PREFIXES) {
    if (normalizedPrefix.startsWith(prefix)) {
      const result = parseExecApprovalResultWithMetadata(raw, prefix.length, separator);
      return result ? { kind, raw, ...result } : { kind: "other" as const, raw };
    }
  }

  const completedMatch = EXEC_COMPLETED_RE.exec(raw);
  if (completedMatch) {
    return {
      kind: "completed" as const,
      raw,
      body: completedMatch[1]?.trim() ?? "",
    };
  }

  return { kind: "other" as const, raw };
}

export function isExecDeniedResultText(resultText: string): boolean {
  return parseExecApprovalResultText(resultText).kind === "denied";
}

export function formatExecDeniedUserMessage(resultText: string): string | null {
  const parsed = parseExecApprovalResultText(resultText);
  if (parsed.kind !== "denied") {
    return null;
  }

  return formatExecDeniedReasonMessage(parsed.metadata);
}

export function formatExecDeniedReasonMessage(deniedReason: string): string {
  const reason = normalizeLowercaseStringOrEmpty(deniedReason);
  if (reason.includes("approval-timeout")) {
    return "Command did not run: approval timed out.";
  }
  if (reason.includes("user-denied")) {
    return "Command did not run: an operator declined this execution approval.";
  }
  if (reason.includes("allowlist-miss") || reason === "approval-required") {
    return "Command did not run: approval is required.";
  }
  if (reason.includes("approval-request-failed") || reason === "request-failed") {
    return "Command did not run: approval request failed.";
  }
  return "Command did not run.";
}
