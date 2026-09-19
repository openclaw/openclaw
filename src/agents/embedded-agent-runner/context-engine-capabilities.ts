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
  explicitAgentId?: string;
  authProfileId?: string;
  contextEnginePluginId?: string;
  purpose: string;
  /**
   * Asserts the admitting run still owns execution authority. Engines retain
   * the returned capability beyond the call that minted it, so the gate keeps
   * a retained completion from acting after close, replacement, or abort.
   */
  assertRunAuthorityActive?: () => void;
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
    agentId: params.explicitAgentId,
  });
  const contextEnginePluginId = normalizeOptionalString(params.contextEnginePluginId);
  return {
    llm: {
      complete: async (request) => {
        params.assertRunAuthorityActive?.();
        const { createRuntimeLlm } = await import("../../plugins/runtime/runtime-llm.runtime.js");
        return await createRuntimeLlm({
          getConfig: () => params.config,
          authority: {
            caller: { kind: "context-engine", id: params.purpose },
            requiresBoundAgent: true,
            // The runtime re-asserts this after acquisition and at the final
            // provider boundary, so revocation during awaited preparation still
            // stops the retained completion before dispatch.
            ...(params.assertRunAuthorityActive
              ? { assertCurrent: params.assertRunAuthorityActive }
              : {}),
            ...(sessionKey ? { sessionKey } : {}),
            ...(agentId ? { agentId } : {}),
            ...(params.authProfileId ? { preferredProfile: params.authProfileId } : {}),
            ...(contextEnginePluginId ? { pluginIdForPolicy: contextEnginePluginId } : {}),
            allowAgentIdOverride: false,
            allowModelOverride: false,
            allowComplete: true,
          },
        }).complete(request);
      },
    },
  };
}
