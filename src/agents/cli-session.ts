import crypto from "node:crypto";
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { CLAUDE_CLI_BACKEND_ID } from "../plugin-sdk/anthropic-cli.js";
import { normalizeProviderId } from "./model-selection.js";

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = trimOptional(value);
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
  const bindingSessionId = trimOptional(fromBindings?.sessionId);
  if (bindingSessionId) {
    return {
      sessionId: bindingSessionId,
      authProfileId: trimOptional(fromBindings?.authProfileId),
      extraSystemPromptHash: trimOptional(fromBindings?.extraSystemPromptHash),
      mcpConfigHash: trimOptional(fromBindings?.mcpConfigHash),
    };
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  if (fromMap?.trim()) {
    return { sessionId: fromMap.trim() };
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    const legacy = entry.claudeCliSessionId?.trim();
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
      ...(trimOptional(binding.authProfileId)
        ? { authProfileId: trimOptional(binding.authProfileId) }
        : {}),
      ...(trimOptional(binding.extraSystemPromptHash)
        ? { extraSystemPromptHash: trimOptional(binding.extraSystemPromptHash) }
        : {}),
      ...(trimOptional(binding.mcpConfigHash)
        ? { mcpConfigHash: trimOptional(binding.mcpConfigHash) }
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
  extraSystemPromptHash?: string;
  mcpConfigHash?: string;
}): { sessionId?: string; invalidatedReason?: "auth-profile" | "system-prompt" | "mcp" } {
  const binding = params.binding;
  const sessionId = trimOptional(binding?.sessionId);
  if (!sessionId) {
    return {};
  }
  const currentAuthProfileId = trimOptional(params.authProfileId);
  const currentExtraSystemPromptHash = trimOptional(params.extraSystemPromptHash);
  const currentMcpConfigHash = trimOptional(params.mcpConfigHash);
  const storedAuthProfileId = trimOptional(binding?.authProfileId);
  if (storedAuthProfileId !== currentAuthProfileId) {
    return { invalidatedReason: "auth-profile" };
  }
  const storedExtraSystemPromptHash = trimOptional(binding?.extraSystemPromptHash);
  if (storedExtraSystemPromptHash !== currentExtraSystemPromptHash) {
    return { invalidatedReason: "system-prompt" };
  }
  const storedMcpConfigHash = trimOptional(binding?.mcpConfigHash);
  if (storedMcpConfigHash !== currentMcpConfigHash) {
    return { invalidatedReason: "mcp" };
  }
  return { sessionId };
}
