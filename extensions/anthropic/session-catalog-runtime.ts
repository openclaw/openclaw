import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveModelRuntimePolicy } from "openclaw/plugin-sdk/model-session-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF } from "./cli-constants.js";

export function boundClaudeThreadId(
  pluginId: string,
  entry: {
    cliSessionBindings?: unknown;
    pluginOwnerId?: string;
    modelSelectionLocked?: boolean;
    pluginExtensions?: unknown;
  },
): string | undefined {
  const bindings = isRecord(entry.cliSessionBindings) ? entry.cliSessionBindings : undefined;
  const binding = bindings?.[CLAUDE_CLI_BACKEND_ID];
  if (isRecord(binding) && typeof binding.sessionId === "string") {
    return binding.sessionId;
  }
  if (entry.pluginOwnerId !== pluginId || entry.modelSelectionLocked !== true) {
    return undefined;
  }
  const anthropic = isRecord(entry.pluginExtensions) ? entry.pluginExtensions.anthropic : undefined;
  const marker = isRecord(anthropic) ? anthropic.sessionCatalog : undefined;
  return isRecord(marker) && typeof marker.sourceThreadId === "string"
    ? marker.sourceThreadId
    : undefined;
}

export function resolveClaudeCatalogCreateSession(
  api: OpenClawPluginApi,
): { model: string } | undefined {
  const config = (api.runtime.config?.current?.() ?? api.config ?? {}) as OpenClawConfig;
  const policy = resolveModelRuntimePolicy({
    config,
    provider: "anthropic",
    modelId: CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF,
    agentId: resolveDefaultAgentId(config),
  }).policy;
  return policy?.id?.trim() === CLAUDE_CLI_BACKEND_ID
    ? { model: CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF }
    : undefined;
}
