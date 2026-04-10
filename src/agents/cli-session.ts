import crypto from "node:crypto";
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./model-selection.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

// Matches the full "## Inbound Context (trusted metadata)" block that
// `buildInboundMetaSystemPrompt` (src/auto-reply/reply/inbound-meta.ts) emits,
// including the fenced JSON payload. The channel/provider/surface/chat_id
// fields inside that JSON legitimately differ per transport (e.g. the same
// session receiving an inbound via telegram vs. via the control UI's
// chat.send), which would otherwise drift the `extraSystemPromptHash` and
// force a full CLI session reset on every cross-channel turn. The block is
// always regenerated fresh with the current turn's values, so ignoring it
// for reuse-hash purposes does not hide any stale context from the CLI
// subprocess.
const INBOUND_META_BLOCK_RE =
  /## Inbound Context \(trusted metadata\)[\s\S]*?```json[\s\S]*?```\n?/g;

/**
 * Normalize an `extraSystemPrompt` string before feeding it to
 * `hashCliSessionText` for CLI session-reuse gating. Strips transport-volatile
 * sections that should not invalidate the cached CLI session binding. The
 * original string is still passed to the CLI subprocess unchanged; only the
 * hash input is normalized.
 */
export function normalizeExtraSystemPromptForHash(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length === 0) {
    return value;
  }
  return value
    .replace(INBOUND_META_BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
      authProfileId: normalizeOptionalString(fromBindings?.authProfileId),
      authEpoch: normalizeOptionalString(fromBindings?.authEpoch),
      extraSystemPromptHash: normalizeOptionalString(fromBindings?.extraSystemPromptHash),
      mcpConfigHash: normalizeOptionalString(fromBindings?.mcpConfigHash),
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

export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  return getCliSessionBinding(entry, provider)?.sessionId;
}

export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  setCliSessionBinding(entry, provider, { sessionId });
}

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
      ...(normalizeOptionalString(binding.authProfileId)
        ? { authProfileId: normalizeOptionalString(binding.authProfileId) }
        : {}),
      ...(normalizeOptionalString(binding.authEpoch)
        ? { authEpoch: normalizeOptionalString(binding.authEpoch) }
        : {}),
      ...(normalizeOptionalString(binding.extraSystemPromptHash)
        ? { extraSystemPromptHash: normalizeOptionalString(binding.extraSystemPromptHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpConfigHash)
        ? { mcpConfigHash: normalizeOptionalString(binding.mcpConfigHash) }
        : {}),
    },
  };
  entry.cliSessionIds = { ...entry.cliSessionIds, [normalized]: trimmed };
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = trimmed;
  }
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
    delete entry.claudeCliSessionId;
  }
}

export function clearAllCliSessions(entry: SessionEntry): void {
  delete entry.cliSessionBindings;
  delete entry.cliSessionIds;
  delete entry.claudeCliSessionId;
}

export function resolveCliSessionReuse(params: {
  binding?: CliSessionBinding;
  authProfileId?: string;
  authEpoch?: string;
  extraSystemPromptHash?: string;
  mcpConfigHash?: string;
}): {
  sessionId?: string;
  invalidatedReason?: "auth-profile" | "auth-epoch" | "system-prompt" | "mcp";
} {
  const binding = params.binding;
  const sessionId = normalizeOptionalString(binding?.sessionId);
  if (!sessionId) {
    return {};
  }
  const currentAuthProfileId = normalizeOptionalString(params.authProfileId);
  const currentAuthEpoch = normalizeOptionalString(params.authEpoch);
  const currentExtraSystemPromptHash = normalizeOptionalString(params.extraSystemPromptHash);
  const currentMcpConfigHash = normalizeOptionalString(params.mcpConfigHash);
  const storedAuthProfileId = normalizeOptionalString(binding?.authProfileId);
  if (storedAuthProfileId !== currentAuthProfileId) {
    return { invalidatedReason: "auth-profile" };
  }
  const storedAuthEpoch = normalizeOptionalString(binding?.authEpoch);
  if (storedAuthEpoch !== currentAuthEpoch) {
    return { invalidatedReason: "auth-epoch" };
  }
  const storedExtraSystemPromptHash = normalizeOptionalString(binding?.extraSystemPromptHash);
  if (storedExtraSystemPromptHash !== currentExtraSystemPromptHash) {
    return { invalidatedReason: "system-prompt" };
  }
  const storedMcpConfigHash = normalizeOptionalString(binding?.mcpConfigHash);
  if (storedMcpConfigHash !== currentMcpConfigHash) {
    return { invalidatedReason: "mcp" };
  }
  return { sessionId };
}
