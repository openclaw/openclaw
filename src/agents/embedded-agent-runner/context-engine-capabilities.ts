/**
 * Builds host capabilities passed into context-engine runtime calls.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { resolveBoundAgentIdForSession } from "../session-agent-binding.js";

type ResolveContextEngineCapabilitiesParams = {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  authProfileId?: string;
  contextEnginePluginId?: string;
  purpose: string;
};

/**
 * Resolve the LLM model-override policy for a context-engine's owning plugin.
 * When the context-engine is owned by a plugin that configures
 * `plugins.entries.<id>.llm.allowModelOverride: true`, the authority should
 * reflect that so `assertAllowedModelOverride` can honor the override without
 * relying on a potentially-stale plugin-policy lookup via `getConfig`.
 */
function resolveContextEngineModelOverridePolicy(
  cfg: OpenClawConfig | undefined,
  contextEnginePluginId: string | undefined,
): {
  allowModelOverride: boolean;
  allowedModels?: readonly string[];
  hasAllowedModelsConfig?: boolean;
} {
  if (!cfg || !contextEnginePluginId) {
    return { allowModelOverride: false };
  }
  const entry = normalizePluginsConfig(cfg.plugins).entries[contextEnginePluginId]?.llm;
  if (entry?.allowModelOverride === true) {
    return {
      allowModelOverride: true,
      allowedModels: entry.allowedModels,
      hasAllowedModelsConfig: entry.hasAllowedModelsConfig === true,
    };
  }
  return { allowModelOverride: false };
}

/**
 * Build host-owned capabilities that are bound to one context-engine runtime call.
 */
export function resolveContextEngineCapabilities(
  params: ResolveContextEngineCapabilitiesParams,
): Pick<ContextEngineRuntimeContext, "llm"> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const agentId = resolveBoundAgentIdForSession({
    config: params.config,
    sessionKey,
    agentId: params.agentId,
  });
  const contextEnginePluginId = normalizeOptionalString(params.contextEnginePluginId);
  const modelOverridePolicy = resolveContextEngineModelOverridePolicy(
    params.config,
    contextEnginePluginId,
  );
  return {
    llm: {
      complete: async (request) => {
        const { createRuntimeLlm } = await import("../../plugins/runtime/runtime-llm.runtime.js");
        return await createRuntimeLlm({
          getConfig: () => params.config,
          authority: {
            caller: { kind: "context-engine", id: params.purpose },
            requiresBoundAgent: true,
            ...(sessionKey ? { sessionKey } : {}),
            ...(agentId ? { agentId } : {}),
            ...(params.authProfileId ? { preferredProfile: params.authProfileId } : {}),
            ...(contextEnginePluginId ? { pluginIdForPolicy: contextEnginePluginId } : {}),
            allowAgentIdOverride: false,
            allowModelOverride: modelOverridePolicy.allowModelOverride,
            ...(modelOverridePolicy.allowedModels
              ? { allowedModels: modelOverridePolicy.allowedModels }
              : {}),
            ...(modelOverridePolicy.hasAllowedModelsConfig ? { hasAllowedModelsConfig: true } : {}),
            allowComplete: true,
          },
        }).complete(request);
      },
    },
  };
}
