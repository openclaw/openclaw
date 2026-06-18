/**
 * Builds host capabilities passed into context-engine runtime calls.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
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
  // Resolve per-plugin allowModelOverride / allowAgentIdOverride from the
  // plugin's config entry so that LCM compaction and other context-engine
  // consumers honor the plugin's configured LLM authority.  Default to false
  // when no plugin config is found or the field is unset. (#94289)
  const pluginLlmConfig = contextEnginePluginId
    ? params.config?.plugins?.entries?.[contextEnginePluginId]?.llm
    : undefined;
  const pluginAllowModelOverride =
    pluginLlmConfig && typeof pluginLlmConfig === "object" && !Array.isArray(pluginLlmConfig)
      ? (pluginLlmConfig as Record<string, unknown>).allowModelOverride === true
      : false;
  const pluginAllowAgentIdOverride =
    pluginLlmConfig && typeof pluginLlmConfig === "object" && !Array.isArray(pluginLlmConfig)
      ? (pluginLlmConfig as Record<string, unknown>).allowAgentIdOverride === true
      : false;

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
            allowAgentIdOverride: pluginAllowAgentIdOverride,
            allowModelOverride: pluginAllowModelOverride,
            allowComplete: true,
          },
        }).complete(request);
      },
    },
  };
}
