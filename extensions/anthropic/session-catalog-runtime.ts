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
  return api.runtime.config.current() as OpenClawConfig;
}

/** An OpenClaw session that drives a Claude thread. `adopted` marks the ones
    this catalog owns; the rest merely route their turns through the Claude CLI. */
export type BoundClaudeSession = { adopted: boolean; sessionKey: string };

const boundSessionsByApi = new WeakMap<
  OpenClawPluginApi,
  WeakMap<
    object,
    WeakMap<OpenClawConfig, Map<string | undefined, ReadonlyMap<string, BoundClaudeSession>>>
  >
>();

export function listBoundClaudeSessions(
  api: OpenClawPluginApi,
  agentId?: string,
  sessionEntries?: SessionCatalogEntrySnapshot,
): ReadonlyMap<string, BoundClaudeSession> {
  const config = currentClaudeSessionCatalogConfig(api);
  const revision = sessionEntries?.revision;
  let revisions = boundSessionsByApi.get(api);
  let configs = revision ? revisions?.get(revision) : undefined;
  let agents = configs?.get(config);
  const cached = agents?.get(agentId);
  if (cached) {
    return cached;
  }
  const bound = new Map<string, BoundClaudeSession>();
  const pluginId = api.id;
  const entries = listSessionCatalogEntries({
    agentId,
    config,
    runtime: api.runtime,
    sessionEntries,
  });
  // oxlint-disable-next-line typescript/prefer-for-of -- Frozen-array iterators allocate per row.
  for (let index = 0; index < entries.length; index++) {
    const { sessionKey, entry } = entries[index]!;
    // A CLI resume binding is distinct from catalog ownership; ordinary routed
    // sessions remain bound, never adopted.
    const adopted = entry.pluginOwnerId === pluginId;
    const bindings = isRecord(entry.cliSessionBindings) ? entry.cliSessionBindings : undefined;
    const binding = bindings?.[CLAUDE_CLI_BACKEND_ID];
    let threadId =
      isRecord(binding) && typeof binding.sessionId === "string" && binding.sessionId
        ? binding.sessionId
        : undefined;
    // Most rows have neither binding. Avoid their catalog and host metadata reads.
    if (!threadId && (!adopted || entry.modelSelectionLocked !== true)) {
      continue;
    }
    const anthropic = isRecord(entry.pluginExtensions)
      ? entry.pluginExtensions.anthropic
      : undefined;
    const marker = isRecord(anthropic) ? anthropic.sessionCatalog : undefined;
    if (threadId === undefined) {
      if (!isRecord(marker) || typeof marker.sourceThreadId !== "string") {
        continue;
      }
      threadId = marker.sourceThreadId;
    }
    const hostId =
      isRecord(marker) && typeof marker.sourceHostId === "string"
        ? marker.sourceHostId
        : entry.execHost === "node" && entry.execNode?.trim()
          ? `node:${entry.execNode.trim()}`
          : CLAUDE_LOCAL_SESSION_HOST_ID;
    const sourceKey = adoptedSourceKey(hostId, threadId);
    // Sessions from several agents can hold a binding to one Claude thread, and
    // this key does not carry the agent. Adoption is the fact the catalog reads
    // here, so an adopted entry holds the key: a sibling agent's plain CLI
    // binding must never decide that an adopted row is unowned.
    if (bound.get(sourceKey)?.adopted && !adopted) {
      continue;
    }
    bound.set(sourceKey, { adopted, sessionKey });
  }
  if (revision) {
    if (!revisions) {
      revisions = new WeakMap();
      boundSessionsByApi.set(api, revisions);
    }
    if (!configs) {
      configs = new WeakMap();
      revisions.set(revision, configs);
    }
    if (!agents) {
      agents = new Map();
      configs.set(config, agents);
    }
    agents.set(agentId, bound);
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
