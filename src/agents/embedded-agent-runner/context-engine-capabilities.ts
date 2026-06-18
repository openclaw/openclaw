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
 *
 * When a contextEnginePluginId is provided, eagerly resolves the owning plugin's
 * LLM model override policy from the injected config so the authority carries
 * both allowModelOverride and allowedModels directly. This ensures overrides
 * are validated from the authority policy on initial startup, without depending
 * on the plugin-policy fallback through getConfig() which may reference a stale
 * config object. See #94289.
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
  // Eagerly resolve the owning plugin's LLM policy so model override settings
  // are available from initial startup, not only after config hot-reload.
  const pluginLlmEntry =
    contextEnginePluginId &&
    (params.config?.plugins?.entries?.[contextEnginePluginId]?.llm ?? undefined);
  const allowModelOverride = pluginLlmEntry?.allowModelOverride === true;
  const allowedModels: readonly string[] | undefined = pluginLlmEntry?.allowedModels;
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
            allowModelOverride,
            ...(allowedModels !== undefined ? { allowedModels } : {}),
            allowComplete: true,
          },
        }).complete(request);
      },
    },
  };
}
