import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory, SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/types.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { setCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-extensions/compaction-safeguard.js";
import contextHooksExtension from "../pi-extensions/context-hooks.js";
import { setContextHooksRuntime } from "../pi-extensions/context-hooks/runtime.js";
import contextPruningExtension from "../pi-extensions/context-pruning.js";
import { setContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

function resolveContextWindowTokens(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningFactory(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): ExtensionFactory | undefined {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") {
    return undefined;
  }
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) {
    return undefined;
  }

  const settings = computeEffectiveSettings(raw);
  if (!settings) {
    return undefined;
  }

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager),
  });

  return contextPruningExtension;
}

function buildContextHooksFactory(params: {
  sessionManager: SessionManager;
  hookCtx: PluginHookAgentContext;
  provider: string;
  modelId: string;
  contextWindowTokens: number;
}): ExtensionFactory | undefined {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner) {
    return undefined;
  }

  setContextHooksRuntime(params.sessionManager, {
    hookRunner,
    hookCtx: params.hookCtx,
    modelId: params.modelId,
    provider: params.provider,
    contextWindowTokens: params.contextWindowTokens,
  });

  return contextHooksExtension;
}

function resolveCompactionMode(cfg?: OpenClawConfig): "default" | "safeguard" {
  return cfg?.agents?.defaults?.compaction?.mode === "safeguard" ? "safeguard" : "default";
}

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
  hookCtx?: PluginHookAgentContext;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      modelContextWindow: params.model?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      contextWindowTokens: contextWindowInfo.tokens,
    });
    factories.push(compactionSafeguardExtension);
  }
  const pruningFactory = buildContextPruningFactory(params);
  if (pruningFactory) {
    factories.push(pruningFactory);
  }
  if (params.hookCtx) {
    const contextHooksFactory = buildContextHooksFactory({
      sessionManager: params.sessionManager,
      hookCtx: params.hookCtx,
      provider: params.provider,
      modelId: params.modelId,
      contextWindowTokens: resolveContextWindowTokens(params),
    });
    if (contextHooksFactory) {
      factories.push(contextHooksFactory);
    }
  }
  return factories;
}

export { ensurePiCompactionReserveTokens };
