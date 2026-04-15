import type {
  ExtensionAPI,
  ExtensionFactory,
  LoadExtensionsResult,
  SessionManager,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginHookToolResultBeforeModelContext } from "../../plugins/hook-types.js";
import type { HookRunner } from "../../plugins/hooks.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { setCompactionSafeguardRuntime } from "../pi-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-hooks/compaction-safeguard.js";
import contextPruningExtension from "../pi-hooks/context-pruning.js";
import { setContextPruningRuntime } from "../pi-hooks/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-hooks/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-hooks/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

type ToolResultBeforeModelHookRunner = Pick<HookRunner, "hasHooks" | "runToolResultBeforeModel">;
// ResourceLoader assigns inline extension paths in factory order (`<inline:1>`,
// `<inline:2>`, ...). We always register the early canonicalization bridge first.
const TOOL_RESULT_BEFORE_MODEL_CAPTURE_INLINE_PATH = "<inline:1>";
type ToolResultTextProjection = {
  text: string;
  toContent: (text: string) => ToolResultEvent["content"];
};

function getToolResultTextProjection(
  content: ToolResultEvent["content"],
): ToolResultTextProjection | undefined {
  // Keep the hook aligned with the canonical tool_result shape that downstream
  // truncation and context guards already understand. Legacy string-backed
  // tool results are skipped rather than implicitly normalized here.
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }

  const [block] = content;
  if (
    !block ||
    typeof block !== "object" ||
    (block as { type?: unknown }).type !== "text" ||
    typeof (block as { text?: unknown }).text !== "string"
  ) {
    return undefined;
  }

  const baseBlock = { ...(block as unknown as Record<string, unknown>) };
  return {
    text: baseBlock.text as string,
    toContent: (nextText) =>
      [
        {
          ...baseBlock,
          text: nextText,
        },
      ] as ToolResultEvent["content"],
  };
}

function buildToolResultBeforeModelFactories(params: {
  sessionManager: SessionManager;
  hookRunner?: ToolResultBeforeModelHookRunner;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}): ExtensionFactory[] {
  if (!params.hookRunner?.hasHooks("tool_result_before_model")) {
    return [];
  }

  const hookContext: PluginHookToolResultBeforeModelContext = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
  };

  const captureFactory: ExtensionFactory = (api: ExtensionAPI) => {
    api.on("tool_result", (event) => {
      if (event.isError) {
        return undefined;
      }

      const projection = getToolResultTextProjection(event.content);
      if (!projection) {
        return undefined;
      }

      let nextText: string | undefined;
      try {
        nextText = params.hookRunner?.runToolResultBeforeModel(
          {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            text: projection.text,
          },
          {
            ...hookContext,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
          },
        )?.text;
      } catch {
        // The embedded bridge intentionally stays fail-open even if a custom
        // hook runner was constructed with stricter failure handling.
        return undefined;
      }

      if (typeof nextText !== "string" || nextText === projection.text) {
        return undefined;
      }

      return {
        content: projection.toContent(nextText),
      };
    });
  };

  return [captureFactory];
}

export function buildEmbeddedExtensionsOverride(params: {
  hasToolResultBeforeModelBridge: boolean;
}): ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined {
  if (!params.hasToolResultBeforeModelBridge) {
    return undefined;
  }

  return (base: LoadExtensionsResult) => {
    const bridgeIndex = base.extensions.findIndex(
      (extension) => extension.path === TOOL_RESULT_BEFORE_MODEL_CAPTURE_INLINE_PATH,
    );
    if (bridgeIndex <= 0) {
      return base;
    }

    const reorderedExtensions = [...base.extensions];
    const [bridgeExtension] = reorderedExtensions.splice(bridgeIndex, 1);
    if (!bridgeExtension) {
      return base;
    }

    reorderedExtensions.unshift(bridgeExtension);
    return {
      ...base,
      extensions: reorderedExtensions,
    };
  };
}

function resolveContextWindowTokens(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextTokens: params.model?.contextTokens,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningFactory(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
}): ExtensionFactory | undefined {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") {
    return undefined;
  }
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId, params.model?.api)) {
    return undefined;
  }

  const settings = computeEffectiveSettings(raw);
  if (!settings) {
    return undefined;
  }
  const transcriptPolicy = resolveTranscriptPolicy({
    modelApi: params.model?.api,
    provider: params.provider,
    modelId: params.modelId,
  });

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    dropThinkingBlocks: transcriptPolicy.dropThinkingBlocks,
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager, {
      provider: params.provider,
      modelId: params.modelId,
    }),
  });

  return contextPruningExtension;
}

function resolveCompactionMode(cfg?: OpenClawConfig): "default" | "safeguard" {
  const compaction = cfg?.agents?.defaults?.compaction;
  // A registered compaction provider requires the safeguard extension path
  if (compaction?.provider) {
    return "safeguard";
  }
  return compaction?.mode === "safeguard" ? "safeguard" : "default";
}

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
  hookRunner?: ToolResultBeforeModelHookRunner;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  factories.push(...buildToolResultBeforeModelFactories(params));
  if (resolveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const qualityGuardCfg = compactionCfg?.qualityGuard;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      modelContextTokens: params.model?.contextTokens,
      modelContextWindow: params.model?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      contextWindowTokens: contextWindowInfo.tokens,
      identifierPolicy: compactionCfg?.identifierPolicy,
      identifierInstructions: compactionCfg?.identifierInstructions,
      customInstructions: compactionCfg?.customInstructions,
      qualityGuardEnabled: qualityGuardCfg?.enabled ?? false,
      qualityGuardMaxRetries: qualityGuardCfg?.maxRetries,
      model: params.model,
      recentTurnsPreserve: compactionCfg?.recentTurnsPreserve,
      provider: compactionCfg?.provider,
    });
    factories.push(compactionSafeguardExtension);
  }
  const pruningFactory = buildContextPruningFactory(params);
  if (pruningFactory) {
    factories.push(pruningFactory);
  }
  return factories;
}

export { ensurePiCompactionReserveTokens };
