import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  deliveryContextFromSession,
  rethrowIncognitoSessionError,
  sessionDeliveryOrigin,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ACTIVE_MEMORY_DEBUG_PREFIX,
  ACTIVE_MEMORY_STATUS_PREFIX,
  type ActiveMemorySearchDebug,
  type ActiveRecallResult,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

export type ActiveMemorySessionSnapshot = {
  sessionKey?: string;
  entry: SessionEntry | undefined;
  readFailed: boolean;
};

/** Request-owned preparation only; the host audience still guards recall and publication. */
export async function prepareActiveMemorySession(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  storePath?: string;
}): Promise<ActiveMemorySessionSnapshot> {
  const sessionKey = params.sessionKey?.trim() || undefined;
  const sessionId = params.sessionId?.trim();
  try {
    if (sessionKey) {
      const entry = await params.api.runtime.agent.session.getSessionEntryAsync({
        agentId: params.agentId,
        sessionKey,
        storePath: params.storePath,
        readConsistency: "latest",
      });
      return { sessionKey, entry, readFailed: false };
    }
    const match = sessionId
      ? await params.api.runtime.agent.session.getSessionEntryByIdAsync({
          agentId: params.agentId,
          sessionId,
          storePath: params.storePath,
          orderBy: "updatedAt",
        })
      : undefined;
    return {
      sessionKey: match?.sessionKey.trim() || undefined,
      entry: match?.entry,
      readFailed: false,
    };
  } catch (error) {
    rethrowIncognitoSessionError(error);
    return { sessionKey, entry: undefined, readFailed: true };
  }
}

export function resolveRecallRunChannelContext(params: {
  sessionEntry?: SessionEntry;
  messageProvider?: string;
  channelId?: string;
}): {
  messageChannel?: string;
  messageProvider?: string;
} {
  const isRunnableChannelName = (channel: string) =>
    !channel.includes(":") && !channel.includes("/");
  const explicitChannel = normalizeOptionalString(params.channelId);
  const explicitProvider = normalizeOptionalString(params.messageProvider);
  // Scoped conversation IDs are not runnable channel names; passing one to
  // the embedded runner fails plugin directory validation.
  const runnableExplicitChannel =
    explicitChannel && isRunnableChannelName(explicitChannel) ? explicitChannel : undefined;
  // Non-webchat providers often pass a raw conversation id as channelId.
  // Keep those ids for filtering, but run the recall sub-agent through the provider.
  const trustedExplicitChannel =
    runnableExplicitChannel &&
    runnableExplicitChannel !== explicitProvider &&
    (!explicitProvider || explicitProvider === "webchat")
      ? runnableExplicitChannel
      : undefined;
  const entryChannel = normalizeOptionalString(
    deliveryContextFromSession(params.sessionEntry)?.channel,
  );
  const strongEntryChannel =
    entryChannel && isRunnableChannelName(entryChannel) ? entryChannel : undefined;
  const weakEntryChannel = normalizeOptionalString(
    sessionDeliveryOrigin(params.sessionEntry)?.provider,
  );
  const channel =
    trustedExplicitChannel ??
    strongEntryChannel ??
    explicitProvider ??
    runnableExplicitChannel ??
    weakEntryChannel;
  return { messageChannel: channel, messageProvider: channel };
}

export function resolveStatusUpdateAgentId(ctx: { agentId?: string; sessionKey?: string }): string {
  const explicit = ctx.agentId?.trim();
  if (explicit) {
    return explicit;
  }
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    return "";
  }
  const match = /^agent:([^:]+):/i.exec(sessionKey);
  return match?.[1]?.trim() ?? "";
}

function formatElapsedMsCompact(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "0ms";
  }
  if (elapsedMs >= 1000) {
    const seconds = elapsedMs / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  return `${Math.round(elapsedMs)}ms`;
}

export function buildPluginStatusLine(params: {
  result: ActiveRecallResult;
  config: ResolvedActiveRecallPluginConfig;
}): string {
  const parts = [
    ACTIVE_MEMORY_STATUS_PREFIX,
    `status=${params.result.status}`,
    `elapsed=${formatElapsedMsCompact(params.result.elapsedMs)}`,
    `query=${params.config.queryMode}`,
  ];
  if (params.result.summary && params.result.summary.length > 0) {
    parts.push(`summary=${params.result.summary.length} chars`);
  }
  return parts.join(" ");
}

export function buildPersistedDebugSummary(result: ActiveRecallResult): string | null {
  if (result.status === "timeout_partial") {
    return `timeout_partial: ${String(result.summary.length)} chars recovered (not persisted)`;
  }
  return result.summary;
}

function buildPluginDebugLine(params: {
  summary?: string | null;
  searchDebug?: ActiveMemorySearchDebug;
}): string | null {
  const cleaned = sanitizeDebugText(params.summary ?? "");
  const warning = sanitizeDebugText(params.searchDebug?.warning ?? "");
  const action = sanitizeDebugText(params.searchDebug?.action ?? "");
  const error = sanitizeDebugText(params.searchDebug?.error ?? "");
  const debugParts: string[] = [];
  for (const key of ["backend", "configuredMode", "effectiveMode", "fallback"] as const) {
    const value = sanitizeDebugText(params.searchDebug?.[key] ?? "");
    if (value) {
      debugParts.push(`${key}=${value}`);
    }
  }
  if (
    typeof params.searchDebug?.searchMs === "number" &&
    Number.isFinite(params.searchDebug.searchMs)
  ) {
    debugParts.push(`searchMs=${Math.max(0, Math.round(params.searchDebug.searchMs))}`);
  }
  if (typeof params.searchDebug?.hits === "number" && Number.isFinite(params.searchDebug.hits)) {
    debugParts.push(`hits=${Math.max(0, Math.floor(params.searchDebug.hits))}`);
  }
  const prefix = debugParts.join(" ");
  const warningAction =
    warning && action && !cleaned
      ? `${warning} ${action}`
      : [warning, action && !cleaned ? action : ""]
          .filter((value): value is string => Boolean(value))
          .join(" | ");
  const messages = uniqueStrings(
    [warningAction, cleaned].filter((value): value is string => Boolean(value)),
  ).join(" | ");
  const body = [prefix, messages].filter(Boolean).join(" | ") || error;
  return body ? `${ACTIVE_MEMORY_DEBUG_PREFIX} ${body}` : null;
}

function sanitizeDebugText(text: string): string {
  let sanitized = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      sanitized += ch;
    }
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

export async function persistPluginStatusLines(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionKey?: string;
  statusLine?: string;
  debugSummary?: string | null;
  searchDebug?: ActiveMemorySearchDebug;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  const debugLine = buildPluginDebugLine({
    summary: params.debugSummary,
    searchDebug: params.searchDebug,
  });
  const agentId = params.agentId.trim();
  if (!agentId && (params.statusLine || debugLine)) {
    return;
  }
  try {
    if (!params.statusLine && !debugLine) {
      const existingEntry = await params.api.runtime.agent.session.getSessionEntryAsync({
        agentId,
        sessionKey,
      });
      const hasActiveMemoryEntry = Array.isArray(existingEntry?.pluginDebugEntries)
        ? existingEntry.pluginDebugEntries.some((entry) => entry?.pluginId === "active-memory")
        : false;
      if (!hasActiveMemoryEntry) {
        return;
      }
    }
    await params.api.runtime.agent.session.patchSessionEntry({
      agentId,
      sessionKey,
      preserveActivity: true,
      update: (existing) => {
        const previousEntries = Array.isArray(existing.pluginDebugEntries)
          ? existing.pluginDebugEntries
          : [];
        const nextEntries = previousEntries.filter(
          (entry) =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof entry.pluginId === "string" &&
            entry.pluginId !== "active-memory",
        );
        const nextLines: string[] = [];
        if (params.statusLine) {
          nextLines.push(params.statusLine);
        }
        if (debugLine) {
          nextLines.push(debugLine);
        }
        if (nextLines.length > 0) {
          nextEntries.push({
            pluginId: "active-memory",
            lines: nextLines,
          });
        }
        return {
          pluginDebugEntries: nextEntries.length > 0 ? nextEntries : undefined,
        };
      },
    });
  } catch (error) {
    rethrowIncognitoSessionError(error);
    params.api.logger.debug?.(
      `active-memory: failed to persist session status note (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
