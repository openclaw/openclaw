import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveProviderThinkingLevel, type ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ResolvedCliBackend } from "../cli-backends.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { findModelCatalogEntry } from "../model-catalog-lookup.js";
import { loadManifestModelCatalog, overlayConfiguredModelCatalog } from "../model-catalog.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { resolveModelContextWindowProfile } from "../model-context-window.js";
import type { RunCliAgentParams } from "./types.js";

/** Selects both CLI capabilities from the same logical/native catalog identity. */
function resolveCliCatalogCapabilities(params: {
  catalog: ModelCatalogEntry[];
  provider: string;
  modelProvider?: string;
  modelId: string;
  normalizedModel: string;
  agentRuntime: string;
  thinkLevel?: ThinkLevel;
}) {
  const providers = uniqueStrings(
    [params.provider, params.modelProvider].filter((provider): provider is string =>
      Boolean(provider),
    ),
  );
  const models = uniqueStrings([params.modelId, params.normalizedModel]);
  let thinkingEntry: ModelCatalogEntry | undefined;
  let selectableContextEntry: ModelCatalogEntry | undefined;
  for (const provider of providers) {
    for (const modelId of models) {
      const entry = findModelCatalogEntry(params.catalog, { provider, modelId });
      thinkingEntry ??= entry;
      if (entry?.contextWindows?.length) {
        selectableContextEntry = entry;
        break;
      }
    }
    if (selectableContextEntry) {
      break;
    }
  }
  return {
    selectableContextEntry,
    providerThinkingLevel: resolveProviderThinkingLevel({
      provider: thinkingEntry?.provider ?? params.modelProvider ?? params.provider,
      model: thinkingEntry?.id ?? params.normalizedModel,
      catalog: params.catalog,
      agentRuntime: params.agentRuntime,
      level: params.thinkLevel,
    }),
  };
}

/** Resolves the context limit and thinking level before CLI prompt preparation. */
export function resolveCliModelCapabilities(params: {
  run: Pick<
    RunCliAgentParams,
    | "config"
    | "provider"
    | "modelContextWindow"
    | "modelContextTokens"
    | "contextWindow"
    | "thinkLevel"
  >;
  runConfig: OpenClawConfig;
  workspaceDir: string;
  backend: Pick<ResolvedCliBackend, "id" | "modelProvider">;
  modelId: string;
  normalizedModel: string;
  contextModelIds: string[];
}) {
  // Aliases can map a canonical id to a CLI shorthand or a user shorthand to
  // a canonical id. Resolve both identities and keep the safest owned limit.
  const contextModelIds = uniqueStrings(params.contextModelIds);
  const contextTokenCandidates = contextModelIds
    .map((model) =>
      resolveContextTokensForModel({
        cfg: params.run.config,
        provider: params.run.provider,
        modelProvider: params.backend.modelProvider,
        model,
        modelContextWindow: params.run.modelContextWindow,
        modelContextTokens: params.run.modelContextTokens,
        allowAsyncLoad: false,
        // A same-name API model may have a different native window from this CLI runtime.
        allowUnscopedModelLookup: false,
      }),
    )
    .filter((tokens) => tokens !== undefined);
  let modelContextTokens = contextTokenCandidates.length
    ? Math.min(...contextTokenCandidates)
    : DEFAULT_CONTEXT_TOKENS;
  // Session-selectable context windows (catalog `contextWindows`, e.g. Claude
  // CLI 200k/1m) cap the resolved window here: the fixed provider contract in
  // resolveAnthropicFixedContextWindow deliberately ignores catalog scalars,
  // so the selected (or default) option must apply after it or a 200k session
  // would auto-compact against a 1M budget.
  const modelCatalog = overlayConfiguredModelCatalog({
    catalog: loadManifestModelCatalog({
      config: params.runConfig,
      workspaceDir: params.workspaceDir,
    }),
    config: params.runConfig,
    workspaceDir: params.workspaceDir,
  });
  const { selectableContextEntry, providerThinkingLevel } = resolveCliCatalogCapabilities({
    catalog: modelCatalog,
    provider: params.run.provider,
    modelProvider: params.backend.modelProvider,
    modelId: params.modelId,
    normalizedModel: params.normalizedModel,
    agentRuntime: params.backend.id,
    thinkLevel: params.run.thinkLevel,
  });
  if (selectableContextEntry) {
    const contextWindowProfile = resolveModelContextWindowProfile({
      catalogEntry: selectableContextEntry,
      selected: params.run.contextWindow,
    });
    // Only an effective option caps the window; the bare catalog scalar stays
    // subordinate to the fixed provider contract above.
    if (contextWindowProfile.contextWindow && contextWindowProfile.contextTokens !== undefined) {
      modelContextTokens = Math.min(modelContextTokens, contextWindowProfile.contextTokens);
    }
  }
  const resolvedContextWindowInfo = resolveContextWindowInfo({
    cfg: params.run.config,
    provider: params.run.provider,
    modelId: params.modelId,
    modelContextTokens,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  // The generic guard rechecks the requested id in config. An alias target may
  // have a tighter owned limit, so the alias-aware result remains an upper bound.
  const contextWindowInfo =
    resolvedContextWindowInfo.tokens > modelContextTokens
      ? { tokens: modelContextTokens, source: "model" as const }
      : resolvedContextWindowInfo;
  return { contextWindowInfo, providerThinkingLevel };
}
