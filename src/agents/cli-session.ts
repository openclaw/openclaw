/**
 * CLI session persistence helpers.
 * Keeps provider-keyed session bindings and reuse fingerprints in one
 * normalized session-store contract.
 */
import crypto from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import {
  normalizeCliSessionReseedReceipt,
  normalizeCliTranscriptCursor,
} from "../config/sessions/cli-session-binding.js";
import { readErrorName } from "../infra/errors.js";
import { isFailoverError } from "./failover-error.js";
import type { FailoverReason } from "./failover/signal.js";
export {
  clearAllCliSessions,
  getCliSessionBinding,
} from "../config/sessions/cli-session-binding.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

/** Whether a failover proves the provider-side conversation can no longer be resumed. */
export function isCliSessionInvalidatingFailoverReason(reason: FailoverReason): boolean {
  // Auth identity changes are handled by the reuse fingerprint's auth epoch.
  // Other execution failures say nothing about the persisted transcript.
  return reason === "session_expired";
}

/** Hash CLI session-sensitive text so reuse checks can compare stable fingerprints. */
export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

/** Projects explicit native continuity; diagnostic sessionId can name the local session. */
export function applyCliSessionBindingResult(
  entry: SessionEntry,
  provider: string,
  meta?: {
    cliSessionBinding?: CliSessionBinding;
    clearCliSessionBinding?: boolean;
  },
): boolean {
  if (meta?.clearCliSessionBinding === true) {
    clearCliSession(entry, provider);
  } else if (meta?.cliSessionBinding?.sessionId.trim()) {
    setCliSessionBinding(entry, provider, meta.cliSessionBinding);
  } else {
    return false;
  }
  return true;
}

/** Revalidates the exact turn owner at native continuity's synchronous commit edge. */
export function assertCliSessionBindingResultCommitAllowed(
  meta: { clearCliSessionBinding?: boolean } | undefined,
  assertSettlementCurrent: () => void,
  abortSignal?: AbortSignal,
): void {
  assertSettlementCurrent();
  // Explicit invalidation is owner cleanup: abort may clear an unusable
  // handle, but never through a closed, released, or replaced turn.
  if (meta?.clearCliSessionBinding !== true) {
    abortSignal?.throwIfAborted();
  }
}

/** Store a CLI session binding and mirror it to the provider-keyed session-id map. */
export function setCliSessionBinding(
  entry: SessionEntry,
  provider: string,
  binding: CliSessionBinding,
): void {
  const normalized = normalizeProviderId(provider);
  const trimmed = binding.sessionId.trim();
  if (!trimmed) {
    return;
  }
  const previousBinding = entry.cliSessionBindings?.[normalized];
  const previousReceipt =
    normalizeOptionalString(previousBinding?.sessionId) === trimmed
      ? normalizeCliSessionReseedReceipt(previousBinding?.reseedReceipt)
      : undefined;
  const reseedReceipt = normalizeCliSessionReseedReceipt(binding.reseedReceipt) ?? previousReceipt;
  const resumeCheckpointId = normalizeOptionalString(binding.resumeCheckpointId);
  const authProfileId = normalizeOptionalString(binding.authProfileId);
  const authEpoch = normalizeOptionalString(binding.authEpoch);
  const nextBinding: CliSessionBinding = {
    sessionId: trimmed,
    ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
    ...(binding.forceReuse === true ? { forceReuse: true } : {}),
    ...(binding.forkNextResume === true ? { forkNextResume: true } : {}),
    ...(authProfileId ? { authProfileId } : {}),
    ...(authEpoch ? { authEpoch } : {}),
    ...(typeof binding.authEpochVersion === "number" && Number.isFinite(binding.authEpochVersion)
      ? { authEpochVersion: binding.authEpochVersion }
      : {}),
  };
  const transcriptCursor = normalizeCliTranscriptCursor(
    binding.transcriptCursor ??
      (previousBinding?.sessionId === trimmed ? previousBinding.transcriptCursor : undefined),
  );
  if (transcriptCursor) {
    nextBinding.transcriptCursor = transcriptCursor;
  }
  for (const field of [
    "extraSystemPromptHash",
    "messageToolPolicyHash",
    "promptToolNamesHash",
    "cwdHash",
    "mcpConfigHash",
    "mcpResumeHash",
  ] as const) {
    const value = normalizeOptionalString(binding[field]);
    if (value) {
      nextBinding[field] = value;
    }
  }
  if (reseedReceipt) {
    nextBinding.reseedReceipt = reseedReceipt;
  }
  entry.cliSessionBindings = {
    ...entry.cliSessionBindings,
    [normalized]: nextBinding,
  };
  entry.cliSessionIds = { ...entry.cliSessionIds, [normalized]: trimmed };
}

export function clearCliSession(entry: SessionEntry, provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (entry.cliSessionBindings?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionBindings };
    delete next[normalized];
    entry.cliSessionBindings = Object.keys(next).length > 0 ? next : undefined;
  }
  if (entry.cliSessionIds?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionIds };
    delete next[normalized];
    entry.cliSessionIds = Object.keys(next).length > 0 ? next : undefined;
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = undefined;
  }
}

/** Cancellation invalidates an unfinished replacement, not established continuity. */
export function shouldClearInterruptedCliSessionBinding(params: {
  interrupted: boolean;
  bindingReplacedDuringRun: boolean;
}): boolean {
  return params.interrupted && params.bindingReplacedDuringRun;
}

export function shouldClearFailedCliSessionBinding(params: {
  error: unknown;
  binding?: CliSessionBinding;
  bindingReplacedDuringRun?: boolean;
  hasNewGeneratedMediaTask?: boolean;
}): boolean {
  if (!normalizeOptionalString(params.binding?.sessionId)) {
    return false;
  }
  // Detached media delivers back into this run later and still needs the binding.
  if (params.hasNewGeneratedMediaTask === true) {
    return false;
  }
  if (isFailoverError(params.error)) {
    return isCliSessionInvalidatingFailoverReason(params.error.reason);
  }
  return shouldClearInterruptedCliSessionBinding({
    interrupted: readErrorName(params.error) === "AbortError",
    bindingReplacedDuringRun: params.bindingReplacedDuringRun === true,
  });
}

export function resolveCliSessionClearReason(error: unknown): string {
  return isFailoverError(error) ? error.reason : (readErrorName(error) ?? "error");
}

type CliSessionInvalidatedReason =
  | "auth-profile"
  | "auth-epoch"
  | "message-policy"
  | "cwd"
  | "mcp"
  | "prompt-tools";

export type CliSessionReuseResult =
  | { mode: "none" }
  | { mode: "reuse"; sessionId: string }
  | {
      mode: "reuse-with-drift";
      sessionId: string;
      drift: { reasons: "system-prompt"[] };
    }
  | { mode: "invalidate"; invalidatedReason: CliSessionInvalidatedReason };

const DEFAULT_MESSAGE_TOOL_POLICY_HASH = hashCliSessionText(
  JSON.stringify({ sourceReplyDeliveryMode: "automatic", requireExplicitMessageTarget: false }),
);
const LEGACY_EXPLICIT_FALSE_MESSAGE_TOOL_POLICY_HASH = hashCliSessionText(
  JSON.stringify({ requireExplicitMessageTarget: false }),
);

function normalizeCliMessageToolPolicyHash(value: string | undefined): string | undefined {
  const hash = normalizeOptionalString(value);
  // v2026.9.8 used these two encodings for automatic replies with implicit targets.
  // Ordinary turn settlement upgrades them to the current fingerprint on the same binding.
  return hash === undefined || hash === LEGACY_EXPLICIT_FALSE_MESSAGE_TOOL_POLICY_HASH
    ? DEFAULT_MESSAGE_TOOL_POLICY_HASH
    : hash;
}

export function resolveCliSessionReuse(params: {
  binding?: CliSessionBinding;
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion: number;
  extraSystemPromptHash?: string;
  messageToolPolicyHash?: string;
  promptToolNamesHash?: string;
  cwdHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
}): CliSessionReuseResult {
  const binding = params.binding;
  const sessionId = normalizeOptionalString(binding?.sessionId);
  if (!sessionId) {
    return { mode: "none" };
  }
  if (binding?.forceReuse === true) {
    return { mode: "reuse", sessionId };
  }
  const currentAuthProfileId = normalizeOptionalString(params.authProfileId);
  const currentAuthEpoch = normalizeOptionalString(params.authEpoch);
  const currentExtraSystemPromptHash = normalizeOptionalString(params.extraSystemPromptHash);
  const currentMessageToolPolicyHash = normalizeCliMessageToolPolicyHash(
    params.messageToolPolicyHash,
  );
  const currentPromptToolNamesHash = normalizeOptionalString(params.promptToolNamesHash);
  const currentCwdHash = normalizeOptionalString(params.cwdHash);
  const currentMcpConfigHash = normalizeOptionalString(params.mcpConfigHash);
  const currentMcpResumeHash = normalizeOptionalString(params.mcpResumeHash);
  const storedAuthProfileId = normalizeOptionalString(binding?.authProfileId);
  const storedAuthEpoch = normalizeOptionalString(binding?.authEpoch);
  const hasMatchingVersionedAuthEpoch =
    binding?.authEpochVersion === params.authEpochVersion &&
    storedAuthEpoch !== undefined &&
    currentAuthEpoch !== undefined &&
    storedAuthEpoch === currentAuthEpoch;
  if (storedAuthProfileId !== currentAuthProfileId && !hasMatchingVersionedAuthEpoch) {
    return { mode: "invalidate", invalidatedReason: "auth-profile" };
  }
  if (
    binding?.authEpochVersion === params.authEpochVersion &&
    storedAuthEpoch !== currentAuthEpoch
  ) {
    return { mode: "invalidate", invalidatedReason: "auth-epoch" };
  }
  const storedMessageToolPolicyHash = normalizeCliMessageToolPolicyHash(
    binding?.messageToolPolicyHash,
  );
  if (storedMessageToolPolicyHash !== currentMessageToolPolicyHash) {
    return { mode: "invalidate", invalidatedReason: "message-policy" };
  }
  const storedCwdHash = normalizeOptionalString(binding?.cwdHash);
  if (storedCwdHash !== undefined && storedCwdHash !== currentCwdHash) {
    return { mode: "invalidate", invalidatedReason: "cwd" };
  }
  const storedMcpResumeHash = normalizeOptionalString(binding?.mcpResumeHash);
  if (storedMcpResumeHash && currentMcpResumeHash) {
    // Resume hashes are stricter than raw MCP config hashes: a match proves the
    // exact resumed CLI tool topology still belongs to this session.
    if (storedMcpResumeHash !== currentMcpResumeHash) {
      return { mode: "invalidate", invalidatedReason: "mcp" };
    }
  } else {
    const storedMcpConfigHash = normalizeOptionalString(binding?.mcpConfigHash);
    if (storedMcpConfigHash !== currentMcpConfigHash) {
      return { mode: "invalidate", invalidatedReason: "mcp" };
    }
  }

  const storedPromptToolNamesHash = normalizeOptionalString(binding?.promptToolNamesHash);
  if (storedPromptToolNamesHash !== currentPromptToolNamesHash) {
    // The loopback bridge cannot notify a resumed CLI to refresh its cached tool catalog.
    return { mode: "invalidate", invalidatedReason: "prompt-tools" };
  }
  const storedExtraSystemPromptHash = normalizeOptionalString(binding?.extraSystemPromptHash);
  if (storedExtraSystemPromptHash !== currentExtraSystemPromptHash) {
    return { mode: "reuse-with-drift", sessionId, drift: { reasons: ["system-prompt"] } };
  }
  return { mode: "reuse", sessionId };
}
