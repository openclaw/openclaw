import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { normalizeProviderId } from "./model-selection.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

/**
 * Hash CLI-session reuse inputs before persisting them into session metadata.
 * The stored value is only an equality token, so prompt/cwd/MCP inputs are not
 * written back into the session store in plaintext.
 */
export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

/**
 * Resolve the stored CLI session binding for a provider. New structured
 * bindings win, older provider-id maps are still read, and the legacy
 * Claude-only field is retained as a final migration fallback.
 */
export function getCliSessionBinding(
  entry: SessionEntry | undefined,
  provider: string,
): CliSessionBinding | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromBindings = entry.cliSessionBindings?.[normalized];
  const bindingSessionId = normalizeOptionalString(fromBindings?.sessionId);
  if (bindingSessionId) {
    return {
      sessionId: bindingSessionId,
      ...(fromBindings?.forceReuse === true ? { forceReuse: true } : {}),
      authProfileId: normalizeOptionalString(fromBindings?.authProfileId),
      authEpoch: normalizeOptionalString(fromBindings?.authEpoch),
      authEpochVersion: fromBindings?.authEpochVersion,
      extraSystemPromptHash: normalizeOptionalString(fromBindings?.extraSystemPromptHash),
      promptToolNamesHash: normalizeOptionalString(fromBindings?.promptToolNamesHash),
      cwdHash: normalizeOptionalString(fromBindings?.cwdHash),
      mcpConfigHash: normalizeOptionalString(fromBindings?.mcpConfigHash),
      mcpResumeHash: normalizeOptionalString(fromBindings?.mcpResumeHash),
    };
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  const normalizedFromMap = normalizeOptionalString(fromMap);
  if (normalizedFromMap) {
    return { sessionId: normalizedFromMap };
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    const legacy = normalizeOptionalString(entry.claudeCliSessionId);
    if (legacy) {
      return { sessionId: legacy };
    }
  }
  return undefined;
}

/** Return only the reusable CLI session id for callers that do not need invalidation metadata. */
export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  return getCliSessionBinding(entry, provider)?.sessionId;
}

/**
 * Store a CLI session id without reuse metadata. Prefer `setCliSessionBinding`
 * when the caller can also persist auth, prompt, cwd, or MCP hashes.
 */
export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  setCliSessionBinding(entry, provider, { sessionId });
}

/**
 * Persist a provider-scoped CLI session binding in all currently supported
 * session-store shapes. The duplicate legacy writes keep older readers working
 * while structured bindings carry the invalidation inputs for newer runtimes.
 */
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
  entry.cliSessionBindings = {
    ...entry.cliSessionBindings,
    [normalized]: {
      sessionId: trimmed,
      ...(binding.forceReuse === true ? { forceReuse: true } : {}),
      ...(normalizeOptionalString(binding.authProfileId)
        ? { authProfileId: normalizeOptionalString(binding.authProfileId) }
        : {}),
      ...(normalizeOptionalString(binding.authEpoch)
        ? { authEpoch: normalizeOptionalString(binding.authEpoch) }
        : {}),
      ...(typeof binding.authEpochVersion === "number" && Number.isFinite(binding.authEpochVersion)
        ? { authEpochVersion: binding.authEpochVersion }
        : {}),
      ...(normalizeOptionalString(binding.extraSystemPromptHash)
        ? { extraSystemPromptHash: normalizeOptionalString(binding.extraSystemPromptHash) }
        : {}),
      ...(normalizeOptionalString(binding.promptToolNamesHash)
        ? { promptToolNamesHash: normalizeOptionalString(binding.promptToolNamesHash) }
        : {}),
      ...(normalizeOptionalString(binding.cwdHash)
        ? { cwdHash: normalizeOptionalString(binding.cwdHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpConfigHash)
        ? { mcpConfigHash: normalizeOptionalString(binding.mcpConfigHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpResumeHash)
        ? { mcpResumeHash: normalizeOptionalString(binding.mcpResumeHash) }
        : {}),
    },
  };
  entry.cliSessionIds = { ...entry.cliSessionIds, [normalized]: trimmed };
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = trimmed;
  }
}

/**
 * Clear one provider's CLI session binding across structured and legacy fields.
 * Other providers' bindings stay intact so a model switch only invalidates the
 * backend that actually failed or changed reuse conditions.
 */
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

/** Clear every persisted CLI session binding from a session entry. */
export function clearAllCliSessions(entry: SessionEntry): void {
  entry.cliSessionBindings = undefined;
  entry.cliSessionIds = undefined;
  entry.claudeCliSessionId = undefined;
}

/**
 * Decide whether a stored CLI session can be reused under the current run
 * inputs. Auth, system prompt, cwd, and MCP changes invalidate the session
 * unless the binding was explicitly marked `forceReuse`.
 */
export function resolveCliSessionReuse(params: {
  binding?: CliSessionBinding;
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion: number;
  extraSystemPromptHash?: string;
  promptToolNamesHash?: string;
  cwdHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
}): {
  sessionId?: string;
  invalidatedReason?: "auth-profile" | "auth-epoch" | "system-prompt" | "cwd" | "mcp";
} {
  const binding = params.binding;
  const sessionId = normalizeOptionalString(binding?.sessionId);
  if (!sessionId) {
    return {};
  }
  if (binding?.forceReuse === true) {
    return { sessionId };
  }
  const currentAuthProfileId = normalizeOptionalString(params.authProfileId);
  const currentAuthEpoch = normalizeOptionalString(params.authEpoch);
  const currentExtraSystemPromptHash = normalizeOptionalString(params.extraSystemPromptHash);
  const currentPromptToolNamesHash = normalizeOptionalString(params.promptToolNamesHash);
  const currentCwdHash = normalizeOptionalString(params.cwdHash);
  const currentMcpConfigHash = normalizeOptionalString(params.mcpConfigHash);
  const currentMcpResumeHash = normalizeOptionalString(params.mcpResumeHash);
  const storedAuthProfileId = normalizeOptionalString(binding?.authProfileId);
  const storedAuthEpoch = normalizeOptionalString(binding?.authEpoch);
  // Versioned auth epochs let a rotated profile keep reuse when the underlying
  // auth material is known to be unchanged, avoiding unnecessary CLI restarts.
  const hasMatchingVersionedAuthEpoch =
    binding?.authEpochVersion === params.authEpochVersion &&
    storedAuthEpoch !== undefined &&
    currentAuthEpoch !== undefined &&
    storedAuthEpoch === currentAuthEpoch;
  if (storedAuthProfileId !== currentAuthProfileId) {
    if (!hasMatchingVersionedAuthEpoch) {
      return { invalidatedReason: "auth-profile" };
    }
  }
  if (
    binding?.authEpochVersion === params.authEpochVersion &&
    storedAuthEpoch !== currentAuthEpoch
  ) {
    return { invalidatedReason: "auth-epoch" };
  }
  const storedExtraSystemPromptHash = normalizeOptionalString(binding?.extraSystemPromptHash);
  if (storedExtraSystemPromptHash !== currentExtraSystemPromptHash) {
    return { invalidatedReason: "system-prompt" };
  }
  const storedPromptToolNamesHash = normalizeOptionalString(binding?.promptToolNamesHash);
  if (storedPromptToolNamesHash !== currentPromptToolNamesHash) {
    return { invalidatedReason: "system-prompt" };
  }
  const storedCwdHash = normalizeOptionalString(binding?.cwdHash);
  if (storedCwdHash !== undefined && storedCwdHash !== currentCwdHash) {
    return { invalidatedReason: "cwd" };
  }
  const storedMcpResumeHash = normalizeOptionalString(binding?.mcpResumeHash);
  if (storedMcpResumeHash && currentMcpResumeHash) {
    if (storedMcpResumeHash !== currentMcpResumeHash) {
      return { invalidatedReason: "mcp" };
    }
    return { sessionId };
  }
  const storedMcpConfigHash = normalizeOptionalString(binding?.mcpConfigHash);
  if (storedMcpConfigHash !== currentMcpConfigHash) {
    return { invalidatedReason: "mcp" };
  }
  return { sessionId };
}
