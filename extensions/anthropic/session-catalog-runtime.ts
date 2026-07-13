import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";

export function currentClaudeSessionCatalogConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config ?? {}) as OpenClawConfig;
}

export function listBoundClaudeSessions(api: OpenClawPluginApi): Map<string, string> {
  const config = currentClaudeSessionCatalogConfig(api);
  const defaultAgentId = resolveDefaultAgentId(config);
  const agentIds = [
    defaultAgentId,
    ...listAgentIds(config).filter((agentId) => agentId !== defaultAgentId),
  ];
  const bound = new Map<string, string>();
  for (const { sessionKey, entry } of agentIds.flatMap((agentId) =>
    api.runtime.agent.session.listSessionEntries({ agentId }),
  )) {
    const binding = entry.cliSessionBindings?.[CLAUDE_CLI_BACKEND_ID];
    if (binding?.sessionId) {
      bound.set(binding.sessionId, sessionKey);
      continue;
    }
    const marker = entry.pluginExtensions?.anthropic?.sessionCatalog;
    if (
      entry.pluginOwnerId !== api.id ||
      entry.modelSelectionLocked !== true ||
      !isRecord(marker) ||
      typeof marker.sourceThreadId !== "string"
    ) {
      continue;
    }
    bound.set(marker.sourceThreadId, sessionKey);
  }
  return bound;
}
