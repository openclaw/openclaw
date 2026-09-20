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

type BoundClaudeSource = { adopted: boolean; hostId: string; threadId: string };

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
    return { adopted, hostId, threadId: binding.sessionId };
  }
  if (!adopted || entry.modelSelectionLocked !== true) {
    return undefined;
  }
  return isRecord(marker) && typeof marker.sourceThreadId === "string"
    ? { adopted, hostId, threadId: marker.sourceThreadId }
    : undefined;
}

export function listBoundClaudeSessions(
  api: OpenClawPluginApi,
  agentId?: string,
  sessionEntries?: SessionCatalogEntrySnapshot,
): Map<string, BoundClaudeSession> {
  const config = currentClaudeSessionCatalogConfig(api);
  const bound = new Map<string, BoundClaudeSession>();
  for (const { sessionKey, entry } of listSessionCatalogEntries({
    agentId,
    config,
    runtime: api.runtime,
    sessionEntries,
  })) {
    const source = boundClaudeSource(api.id, entry);
    if (!source) {
      continue;
    }
    const sourceKey = adoptedSourceKey(source.hostId, source.threadId);
    // Sessions from several agents can hold a binding to one Claude thread, and
    // this key does not carry the agent. Adoption is the fact the catalog reads
    // here, so an adopted entry holds the key: a sibling agent's plain CLI
    // binding must never decide that an adopted row is unowned.
    if (bound.get(sourceKey)?.adopted && !source.adopted) {
      continue;
    }
    bound.set(sourceKey, { adopted: source.adopted, sessionKey });
  }
  return bound;
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
