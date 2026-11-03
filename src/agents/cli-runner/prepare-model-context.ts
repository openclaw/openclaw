import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ResolvedCliBackend } from "../cli-backends.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { loadManifestModelCatalog, overlayConfiguredModelCatalog } from "../model-catalog.js";
import { resolveModelContextWindowProfile } from "../model-context-window.js";
import { isClaudeCliBackendId } from "./helpers.js";
import { resolveCliCatalogCapabilities } from "./model-capabilities.js";
import { resolveClaudeCliContextModelId } from "./prepare-claude.js";
import { resolveAutoCliSessionReseedHistoryChars } from "./session-history.js";
import type { RunCliAgentParams } from "./types.js";

/** Resolve alias-aware model limits and effort from the same prepared catalog. */
export function prepareCliModelContext({
  params,
  backendResolved,
  runConfig,
  workspaceDir,
  modelId,
  normalizedCatalogModel,
}: {
  params: RunCliAgentParams;
  backendResolved: Pick<ResolvedCliBackend, "id" | "modelProvider">;
  runConfig: OpenClawConfig;
  workspaceDir: string;
  modelId: string;
  normalizedCatalogModel: string;
}) {
  const isClaudeCli = isClaudeCliBackendId(params.provider);
  const requestedContextModelId = isClaudeCli ? resolveClaudeCliContextModelId(modelId) : modelId;
  const normalizedContextModelId = isClaudeCli
    ? resolveClaudeCliContextModelId(normalizedCatalogModel)
    : normalizedCatalogModel;
  // Aliases can map a canonical id to a CLI shorthand or a user shorthand to
  // a canonical id. Resolve both identities and keep the safest owned limit.
  const contextModelIds = uniqueStrings([requestedContextModelId, normalizedContextModelId]);
  const contextTokenCandidates = contextModelIds
    .map((model) =>
      resolveContextTokensForModel({
        cfg: params.config,
        provider: params.provider,
        modelProvider: backendResolved.modelProvider,
        model,
        modelContextWindow: params.modelContextWindow,
        modelContextTokens: params.modelContextTokens,
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
    catalog: loadManifestModelCatalog({ config: runConfig, workspaceDir }),
    config: runConfig,
    workspaceDir,
  });
  const { selectableContextEntry, providerThinkingLevel } = resolveCliCatalogCapabilities({
    catalog: modelCatalog,
    provider: params.provider,
    modelProvider: backendResolved.modelProvider,
    modelId,
    normalizedModel: normalizedCatalogModel,
    agentRuntime: backendResolved.id,
    thinkLevel: params.thinkLevel,
  });
  if (selectableContextEntry) {
    const contextWindowProfile = resolveModelContextWindowProfile({
      catalogEntry: selectableContextEntry,
      selected: params.contextWindow,
    });
    // Only an effective option caps the window; the bare catalog scalar stays
    // subordinate to the fixed provider contract above.
    if (contextWindowProfile.contextWindow && contextWindowProfile.contextTokens !== undefined) {
      modelContextTokens = Math.min(modelContextTokens, contextWindowProfile.contextTokens);
    }
  }
  const resolvedContextWindowInfo = resolveContextWindowInfo({
    cfg: params.config,
    provider: params.provider,
    modelId,
    modelContextTokens,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  // The generic guard rechecks the requested id in config. An alias target may
  // have a tighter owned limit, so the alias-aware result remains an upper bound.
  const contextWindowInfo =
    resolvedContextWindowInfo.tokens > modelContextTokens
      ? { tokens: modelContextTokens, source: "model" as const }
      : resolvedContextWindowInfo;
  const autoReseedHistoryChars = isClaudeCli
    ? resolveAutoCliSessionReseedHistoryChars(contextWindowInfo.tokens)
    : undefined;

  return { contextWindowInfo, providerThinkingLevel, autoReseedHistoryChars };
}
