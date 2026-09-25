import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveContextWindowInfo, type ContextWindowInfo } from "../context-window-guard.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { resolveModelContextWindowProfile } from "../model-context-window.js";
import { isClaudeCliBackendId } from "./helpers.js";
import { CLAUDE_CLI_CONTEXT_MODEL_ALIASES } from "./prepare-claude.js";
import { resolveAutoCliSessionReseedHistoryChars } from "./session-history.js";

/**
 * The run's finalized context budget. Preparation is its single owner: every
 * consumer (execution `contextTokenBudget`, the in-process tool set, the MCP
 * loopback grant) receives `contextWindowInfo.tokens` from here rather than
 * re-deriving a window from the raw catalog inputs on the run params.
 */
export type CliRunContextBudget = {
  contextWindowInfo: ContextWindowInfo;
  autoReseedHistoryChars: number | undefined;
};

function resolveClaudeCliContextModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  return CLAUDE_CLI_CONTEXT_MODEL_ALIASES[lower] ?? trimmed;
}

export function resolveCliRunContextBudget(params: {
  config: OpenClawConfig | undefined;
  provider: string;
  backendModelProvider: string | undefined;
  modelId: string;
  normalizedCatalogModel: string;
  /** The session-selected catalog `contextWindows` option id, when any. */
  selectedContextWindow: string | undefined;
  /**
   * The catalog entry that owns selectable `contextWindows` for this run's
   * logical/native identity, already selected by the caller so the catalog is
   * read once for both this budget and the run's thinking level.
   */
  selectableContextEntry: ModelCatalogEntry | undefined;
  modelContextWindow: number | undefined;
  modelContextTokens: number | undefined;
}): CliRunContextBudget {
  const { modelId, normalizedCatalogModel } = params;
  const isClaudeCli = isClaudeCliBackendId(params.provider);
  const requestedContextModelId = isClaudeCli ? resolveClaudeCliContextModelId(modelId) : modelId;
  const normalizedContextModelId = isClaudeCli
    ? resolveClaudeCliContextModelId(normalizedCatalogModel)
    : normalizedCatalogModel;
  // Aliases can map a canonical id to a CLI shorthand or a user shorthand to
  // a canonical id. Resolve both identities and keep the safest owned limit.
  const contextModelIds = [
    requestedContextModelId,
    ...(normalizedContextModelId !== requestedContextModelId ? [normalizedContextModelId] : []),
  ];
  const resolveContextModelTokens = (contextModelId: string) =>
    resolveContextTokensForModel({
      cfg: params.config,
      provider: params.provider,
      modelProvider: params.backendModelProvider,
      model: contextModelId,
      modelContextWindow: params.modelContextWindow,
      modelContextTokens: params.modelContextTokens,
      allowAsyncLoad: false,
      // A same-name API model may have a different native window from this CLI runtime.
      allowUnscopedModelLookup: false,
    });
  let modelContextTokens: number | undefined;
  for (const contextModelId of contextModelIds) {
    const candidateContextTokens = resolveContextModelTokens(contextModelId);
    if (candidateContextTokens !== undefined) {
      modelContextTokens =
        modelContextTokens === undefined
          ? candidateContextTokens
          : Math.min(modelContextTokens, candidateContextTokens);
    }
  }
  modelContextTokens ??= DEFAULT_CONTEXT_TOKENS;
  // Session-selectable context windows (catalog `contextWindows`, e.g. Claude
  // CLI 200k/1m) cap the resolved window here: the fixed provider contract in
  // resolveAnthropicFixedContextWindow deliberately ignores catalog scalars,
  // so the selected (or default) option must apply after it or a 200k session
  // would auto-compact against a 1M budget.
  if (params.selectableContextEntry) {
    const contextWindowProfile = resolveModelContextWindowProfile({
      catalogEntry: params.selectableContextEntry,
      selected: params.selectedContextWindow,
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
  return {
    contextWindowInfo,
    autoReseedHistoryChars: isClaudeCli
      ? resolveAutoCliSessionReseedHistoryChars(contextWindowInfo.tokens)
      : undefined,
  };
}
