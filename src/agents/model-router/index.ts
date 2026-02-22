import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { classifyComplexity } from "./classifier.js";
import { loadModelRouterConfig } from "./config.js";

interface ResolvedTiers {
  cheap: Model<Api>;
  mid: Model<Api>;
  complex: Model<Api>;
}

/**
 * Install a dynamic per-call model router that wraps `activeSession.agent.streamFn`.
 *
 * On every LLM call the wrapper inspects the current messages to decide which
 * model tier to use:
 *   - Tool continuations (last message role === "toolResult") → cheap tier
 *     (unless conversation is complex)
 *   - Complex conversations → complex tier
 *   - Simple conversations → cheap tier
 *   - Everything else → mid tier
 *
 * Configured entirely via `OC_ROUTER_*` env vars.  Returns `{ installed: false }`
 * when the router is disabled so callers can fall back to static routing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStreamFn = (...args: any[]) => any;

export async function installDynamicModelRouter(params: {
  activeSession: { agent: { streamFn: AnyStreamFn } };
  sessionManager: unknown;
  provider: string;
  modelId: string;
  agentDir?: string;
  config?: OpenClawConfig;
}): Promise<{ installed: boolean; tiers?: ResolvedTiers }> {
  const routerConfig = loadModelRouterConfig();
  if (!routerConfig) {
    return { installed: false };
  }

  const { resolveModel } = await import("../pi-embedded-runner/model.js");
  const { activeSession, sessionManager, agentDir, config } = params;

  // Resolve each tier model, falling back to the session's current model on failure.
  function resolveTier(tier: { provider: string; modelId: string }): Model<Api> | null {
    const result = resolveModel(tier.provider, tier.modelId, agentDir, config);
    return result.model ?? null;
  }

  const cheapModel = resolveTier(routerConfig.tiers.cheap);
  const midModel = resolveTier(routerConfig.tiers.mid);
  const complexModel = resolveTier(routerConfig.tiers.complex);

  // Use session's current model as fallback for any tier that failed to resolve.
  const sessionModel = resolveTier({ provider: params.provider, modelId: params.modelId });
  const fallback = sessionModel ?? midModel ?? cheapModel ?? complexModel;
  if (!fallback) {
    return { installed: false };
  }

  const tiers: ResolvedTiers = {
    cheap: cheapModel ?? fallback,
    mid: midModel ?? fallback,
    complex: complexModel ?? fallback,
  };

  // Guard: skip routing if all tiers resolved to the same model.
  if (tiers.cheap.id === tiers.mid.id && tiers.mid.id === tiers.complex.id) {
    return { installed: false };
  }

  const { getContextHooksRuntime } = await import("../pi-extensions/context-hooks/runtime.js");

  const originalStreamFn = activeSession.agent.streamFn;

  activeSession.agent.streamFn = (
    model: Model<Api>,
    context: { messages: Array<{ role?: string }> },
    options?: unknown,
  ) => {
    const msgs = context.messages;
    const lastMsg = msgs[msgs.length - 1];
    const isToolContinuation = lastMsg?.role === "toolResult";
    const complexity = classifyComplexity(msgs, routerConfig.thresholds);

    let chosen: Model<Api>;
    if (isToolContinuation && complexity !== "complex") {
      chosen = tiers[routerConfig.toolContinuationTier];
    } else if (complexity === "complex") {
      chosen = tiers.complex;
    } else if (complexity === "simple") {
      chosen = tiers.cheap;
    } else {
      chosen = tiers.mid; // moderate default
    }

    // Context window safety: don't route large contexts to a small-window model.
    if (chosen.contextWindow && model.contextWindow) {
      const estimatedTokens = Math.ceil(JSON.stringify(msgs).length / 4);
      if (estimatedTokens > chosen.contextWindow * 0.85) {
        chosen = tiers.mid; // fall back to mid-tier with larger window
      }
    }

    // Update context-hooks runtime so before_context_send sees the routed model.
    const contextHooksRuntime = getContextHooksRuntime(sessionManager);
    if (contextHooksRuntime) {
      contextHooksRuntime.modelId = chosen.id;
      contextHooksRuntime.provider = chosen.provider;
      contextHooksRuntime.contextWindowTokens = chosen.contextWindow ?? DEFAULT_CONTEXT_TOKENS;
    }

    return originalStreamFn(chosen, context, options);
  };

  // eslint-disable-next-line no-console
  console.log(
    `model-router: installed dynamic routing (cheap=${tiers.cheap.id}, mid=${tiers.mid.id}, complex=${tiers.complex.id})`,
  );

  return { installed: true, tiers };
}
