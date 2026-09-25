import { resolveEffectiveAgentRuntime } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  listSessionCatalogEntries,
  type SessionCatalogEntrySnapshot,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_ROUTE_PROBE_MODEL_IDS } from "./cli-constants.js";
import { adoptedSourceKey, CLAUDE_LOCAL_SESSION_HOST_ID } from "./session-catalog-adoption.js";

export function currentClaudeSessionCatalogConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config ?? {}) as OpenClawConfig;
}

type BoundClaudeSource = {
  adopted: boolean;
  /** A catalog fork that still points at its source thread: it has not run yet. */
  pendingFork: boolean;
  hostId: string;
  threadId: string;
};

/** An OpenClaw session that drives a Claude thread. `adopted` marks the ones
    this catalog owns; the rest merely route their turns through the Claude CLI. */
export type BoundClaudeSession = { adopted: boolean; sessionKey: string };

function boundClaudeSource(
  pluginId: string,
  entry: {
    cliSessionBindings?: unknown;
    execHost?: string;
    execNode?: string;
    pluginOwnerId?: string;
    modelSelectionLocked?: boolean;
    pluginExtensions?: unknown;
  },
): BoundClaudeSource | undefined {
  const anthropic = isRecord(entry.pluginExtensions) ? entry.pluginExtensions.anthropic : undefined;
  const marker = isRecord(anthropic) ? anthropic.sessionCatalog : undefined;
  const hostId =
    isRecord(marker) && typeof marker.sourceHostId === "string"
      ? marker.sourceHostId
      : entry.execHost === "node" && typeof entry.execNode === "string" && entry.execNode.trim()
        ? `node:${entry.execNode.trim()}`
        : CLAUDE_LOCAL_SESSION_HOST_ID;
  // A CLI resume binding only records which Claude thread this session last
  // drove. Catalog ownership is what makes the session a Claude Code
  // conversation, so the two are reported separately: an ordinary OpenClaw
  // session routed to the Claude CLI is bound, never adopted.
  const adopted = entry.pluginOwnerId === pluginId;
  const bindings = isRecord(entry.cliSessionBindings) ? entry.cliSessionBindings : undefined;
  const binding = bindings?.[CLAUDE_CLI_BACKEND_ID];
  if (isRecord(binding) && typeof binding.sessionId === "string" && binding.sessionId) {
    const pendingFork =
      adopted &&
      entry.modelSelectionLocked === true &&
      isRecord(marker) &&
      marker.sourceThreadId === binding.sessionId;
    return { adopted, pendingFork, hostId, threadId: binding.sessionId };
  }
  if (!adopted || entry.modelSelectionLocked !== true) {
    return undefined;
  }
  return isRecord(marker) && typeof marker.sourceThreadId === "string"
    ? { adopted, pendingFork: true, hostId, threadId: marker.sourceThreadId }
    : undefined;
}

// Lower wins a shared source key. An established catalog session holds its key
// against a sibling's plain CLI binding; a pending fork never displaces the
// thread's original owner, including a fork left by a failed adoption.
function sourceRank(source: BoundClaudeSource): number {
  return source.pendingFork ? 2 : source.adopted ? 0 : 1;
}

export function listBoundClaudeSessions(
  api: OpenClawPluginApi,
  agentId?: string,
  sessionEntries?: SessionCatalogEntrySnapshot,
): Map<string, BoundClaudeSession> {
  const config = currentClaudeSessionCatalogConfig(api);
  const explicitOwnership = config.agents?.ownership === "explicit";
  // Ownership resolves across agents: hiding another agent's binding makes its
  // Claude thread look unowned, and continuing it creates a wrong-agent copy.
  const winners = new Map<string, { sessionKey: string; source: BoundClaudeSource }>();
  for (const {
    agentId: ownerAgentId,
    sessionKey,
    entry,
    activeNativeSession,
  } of listSessionCatalogEntries({
    agentId,
    includeOtherAgents: true,
    config,
    runtime: api.runtime,
    sessionEntries,
  })) {
    // A first turn publishes its thread before the binding persists at settlement.
    const source: BoundClaudeSource | undefined =
      activeNativeSession?.backendId === CLAUDE_CLI_BACKEND_ID
        ? { adopted: entry.pluginOwnerId === api.id, pendingFork: false, ...activeNativeSession }
        : boundClaudeSource(api.id, entry);
    // Explicit agents keep independent catalog forks of the same source.
    if (!source || (source.pendingFork && explicitOwnership && ownerAgentId !== agentId)) {
      continue;
    }
    const key = adoptedSourceKey(source.hostId, source.threadId);
    const current = winners.get(key);
    if (current && current.sessionKey !== sessionKey) {
      const rank = sourceRank(source);
      const currentRank = sourceRank(current.source);
      if (rank === currentRank) {
        throw new Error("multiple OpenClaw sessions bind Claude thread from the same host");
      }
      if (rank > currentRank) {
        continue;
      }
    }
    winners.set(key, { sessionKey, source });
  }
  return new Map(
    [...winners].map(([key, { sessionKey, source }]) => [
      key,
      { adopted: source.adopted, sessionKey },
    ]),
  );
}

/**
 * Resolve the Claude model an agent actually routes to the Claude CLI backend.
 * Callers must not assume the current default is routed: existing configs pin
 * older Claude models, and stamping the default onto their sessions would
 * select a model the operator never routed or allowed.
 */
export function resolveClaudeCliRoutedModelId(
  config: OpenClawConfig,
  agentId: string,
): string | undefined {
  return CLAUDE_CLI_ROUTE_PROBE_MODEL_IDS.find(
    (modelId) =>
      resolveEffectiveAgentRuntime({
        cfg: config,
        provider: "anthropic",
        modelId,
        agentId,
      }) === CLAUDE_CLI_BACKEND_ID,
  );
}
