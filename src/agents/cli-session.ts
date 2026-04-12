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

export function resolveBoundCliSessionProviders(
  entry:
    | Pick<SessionEntry, "cliSessionBindings" | "cliSessionIds" | "claudeCliSessionId">
    | undefined,
): string[] {
  const providers = new Set<string>();
  if (entry?.cliSessionBindings) {
    for (const [provider, binding] of Object.entries(entry.cliSessionBindings)) {
      if (normalizeOptionalString(binding?.sessionId)) {
        providers.add(normalizeProviderId(provider));
      }
    }
  }
  if (entry?.cliSessionIds) {
    for (const [provider, sessionId] of Object.entries(entry.cliSessionIds)) {
      if (normalizeOptionalString(sessionId)) {
        providers.add(normalizeProviderId(provider));
      }
    }
  }
  if (normalizeOptionalString(entry?.claudeCliSessionId)) {
    providers.add(CLAUDE_CLI_BACKEND_ID);
  }
  return [...providers];
}

export function resolveSuppressedCliHistoryImportProviders(
  entry:
    | Pick<
        SessionEntry,
        | "suppressCliHistoryImport"
        | "suppressCliHistoryImportProviders"
        | "cliSessionBindings"
        | "cliSessionIds"
        | "claudeCliSessionId"
      >
    | undefined,
): string[] {
  const explicitProviders = Array.isArray(entry?.suppressCliHistoryImportProviders)
    ? entry.suppressCliHistoryImportProviders
        .map((provider) => normalizeOptionalString(provider))
        .filter((provider): provider is string => Boolean(provider))
        .map((provider) => normalizeProviderId(provider))
    : [];
  if (explicitProviders.length > 0) {
    return [...new Set(explicitProviders)];
  }
  if (entry?.suppressCliHistoryImport) {
    return resolveBoundCliSessionProviders(entry);
  }
  return [];
}

function setSuppressedCliHistoryImportProviders(
  entry: SessionEntry,
  providers: Iterable<string>,
): void {
  const normalizedProviders = [
    ...new Set([...providers].map((provider) => normalizeProviderId(provider))),
  ];
  entry.suppressCliHistoryImportProviders =
    normalizedProviders.length > 0 ? normalizedProviders : undefined;
  entry.suppressCliHistoryImport = normalizedProviders.length > 0 ? true : undefined;
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
  const previousSessionId = getCliSessionBinding(entry, normalized)?.sessionId;
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
  if (previousSessionId !== trimmed) {
    const remainingSuppressedProviders = new Set(resolveSuppressedCliHistoryImportProviders(entry));
    remainingSuppressedProviders.delete(normalized);
    setSuppressedCliHistoryImportProviders(entry, remainingSuppressedProviders);
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
  setSuppressedCliHistoryImportProviders(entry, resolveSuppressedCliHistoryImportProviders(entry));
  // Reset-created sessions should keep CLI import suppression until a fresh
  // CLI binding is written back to the session entry.
}

export function clearAllCliSessions(entry: SessionEntry): void {
  setSuppressedCliHistoryImportProviders(entry, []);
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
