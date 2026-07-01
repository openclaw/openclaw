/**
 * Telegram inline button utilities for model selection.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_prov              - show providers list
 * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
 * - mdl_sel_{provider/id} - select model (standard)
 * - mdl_sel/{model}       - select model (compact fallback when standard is >64 bytes)
 * - mdl_idx_{provider}_{i}- select model by sorted-list index (final fallback
 *                           when even the compact encoding exceeds 64 bytes,
 *                          e.g. long Ollama namespaced names)
 * - mdl_back              - back to providers list
 */
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { fitsTelegramCallbackData } from "./approval-callback-data.js";

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export type ParsedModelCallback =
  | { type: "providers" }
  | { type: "list"; provider: string; page: number }
  | { type: "select"; provider?: string; model: string }
  | { type: "select-index"; provider: string; index: number }
  | { type: "back" };

export type ProviderInfo = {
  id: string;
  count: number;
};

export type ResolveModelSelectionResult =
  | { kind: "resolved"; provider: string; model: string }
  | { kind: "ambiguous"; model: string; matchingProviders: string[] };

export type ModelsKeyboardParams = {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  /** Optional map from provider/model to display name. When provided, the
   *  display name is shown on the button instead of the raw model ID. */
  modelNames?: ReadonlyMap<string, string>;
};

const MODELS_PAGE_SIZE = 8;
const CALLBACK_PREFIX = {
  providers: "mdl_prov",
  back: "mdl_back",
  list: "mdl_list_",
  selectStandard: "mdl_sel_",
  selectCompact: "mdl_sel/",
  selectIndex: "mdl_idx_",
} as const;

/**
 * Parse a model callback_data string into a structured object.
 * Returns null if the data doesn't match a known pattern.
 */
export function parseModelCallbackData(data: string): ParsedModelCallback | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith("mdl_")) {
    return null;
  }

  if (trimmed === CALLBACK_PREFIX.providers || trimmed === CALLBACK_PREFIX.back) {
    return { type: trimmed === CALLBACK_PREFIX.providers ? "providers" : "back" };
  }

  // mdl_list_{provider}_{page}
  const listMatch = trimmed.match(/^mdl_list_([a-z0-9_.-]+)_(\d+)$/i);
  if (listMatch) {
    const [, provider, pageStr] = listMatch;
    const page = parseStrictPositiveInteger(pageStr);
    if (provider && page !== undefined) {
      return { type: "list", provider, page };
    }
  }

  // mdl_sel/{model} (compact fallback)
  const compactSelMatch = trimmed.match(/^mdl_sel\/(.+)$/);
  if (compactSelMatch) {
    const modelRef = compactSelMatch[1];
    if (modelRef) {
      return {
        type: "select",
        model: modelRef,
      };
    }
  }

  // mdl_idx_{provider}_{index} (index-based fallback for names that exceed the
  // 64-byte limit even in compact form). The resolver looks the index up in
  // the provider's alphabetically sorted model list.
  const indexSelMatch = trimmed.match(/^mdl_idx_([a-z0-9_.-]+)_(\d+)$/i);
  if (indexSelMatch) {
    const [, provider, indexStr] = indexSelMatch;
    const index = Number(indexStr);
    if (provider && Number.isSafeInteger(index) && index >= 0) {
      return { type: "select-index", provider, index };
    }
  }

  // mdl_sel_{provider/model}
  const selMatch = trimmed.match(/^mdl_sel_(.+)$/);
  if (selMatch) {
    const modelRef = selMatch[1];
    if (modelRef) {
      const slashIndex = modelRef.indexOf("/");
      if (slashIndex > 0 && slashIndex < modelRef.length - 1) {
        return {
          type: "select",
          provider: modelRef.slice(0, slashIndex),
          model: modelRef.slice(slashIndex + 1),
        };
      }
    }
  }

  return null;
}

export function buildModelSelectionCallbackData(params: {
  provider: string;
  model: string;
  /**
   * Optional position of this model in the provider's alphabetically sorted
   * model list. When provided, used as the final fallback for names that
   * exceed Telegram's 64-byte callback_data limit even in compact form,
   * instead of silently dropping the model.
   */
  sortedIndex?: number;
}): string | null {
  const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
  if (fitsTelegramCallbackData(fullCallbackData)) {
    return fullCallbackData;
  }
  const compactCallbackData = `${CALLBACK_PREFIX.selectCompact}${params.model}`;
  if (fitsTelegramCallbackData(compactCallbackData)) {
    return compactCallbackData;
  }
  if (params.sortedIndex !== undefined && params.sortedIndex >= 0) {
    const indexCallbackData = `${CALLBACK_PREFIX.selectIndex}${params.provider}_${params.sortedIndex}`;
    if (fitsTelegramCallbackData(indexCallbackData)) {
      return indexCallbackData;
    }
  }
  return null;
}

export function resolveModelSelection(params: {
  callback: Extract<ParsedModelCallback, { type: "select" | "select-index" }>;
  providers: readonly string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): ResolveModelSelectionResult {
  if (params.callback.type === "select-index") {
    const modelSet = params.byProvider.get(params.callback.provider);
    if (!modelSet || modelSet.size === 0) {
      return {
        kind: "ambiguous",
        model: `<index:${params.callback.index}>`,
        matchingProviders: [],
      };
    }
    // The keyboard sorts the provider's models alphabetically before paginating,
    // so the index in the callback maps directly to the sorted list position.
    const sortedModels = [...modelSet].toSorted((left, right) => left.localeCompare(right));
    const model = sortedModels[params.callback.index];
    if (!model) {
      return {
        kind: "ambiguous",
        model: `<index:${params.callback.index}>`,
        matchingProviders: [],
      };
    }
    return { kind: "resolved", provider: params.callback.provider, model };
  }

  if (params.callback.provider) {
    return {
      kind: "resolved",
      provider: params.callback.provider,
      model: params.callback.model,
    };
  }
  const matchingProviders = params.providers.filter((id) =>
    params.byProvider.get(id)?.has(params.callback.model),
  );
  if (matchingProviders.length === 1) {
    return {
      kind: "resolved",
      provider: matchingProviders[0],
      model: params.callback.model,
    };
  }
  return {
    kind: "ambiguous",
    model: params.callback.model,
    matchingProviders,
  };
}

function isCurrentModelSelection(params: {
  currentModel?: string;
  provider: string;
  model: string;
}): boolean {
  const currentModel = params.currentModel?.trim();
  if (!currentModel) {
    return false;
  }
  return currentModel.includes("/")
    ? currentModel === `${params.provider}/${params.model}`
    : currentModel === params.model;
}

/**
 * Build provider selection keyboard with 2 providers per row.
 */
export function buildProviderKeyboard(providers: ProviderInfo[]): ButtonRow[] {
  if (providers.length === 0) {
    return [];
  }

  const rows: ButtonRow[] = [];
  let currentRow: ButtonRow = [];

  for (const provider of providers) {
    const button = {
      text: `${provider.id} (${provider.count})`,
      callback_data: `mdl_list_${provider.id}_1`,
    };

    currentRow.push(button);

    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  // Push any remaining button
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Build model list keyboard with pagination and back button.
 */
export function buildModelsKeyboard(params: ModelsKeyboardParams): ButtonRow[] {
  const { provider, models, currentModel, currentPage, totalPages, modelNames } = params;
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;

  if (models.length === 0) {
    return [[{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]];
  }

  const rows: ButtonRow[] = [];

  // Calculate page slice
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);

  // `models` is the provider's full alphabetically-sorted list (the caller
  // sorts before paginating), so the global index of each model is its
  // position in `models`. We pass that index as a final callback_data fallback
  // so models whose names overflow Telegram's 64-byte limit (even in compact
  // form) still get a usable button instead of being silently dropped.
  for (let pageOffset = 0; pageOffset < pageModels.length; pageOffset += 1) {
    const model = pageModels[pageOffset];
    if (model === undefined) {
      continue;
    }
    const sortedIndex = startIndex + pageOffset;
    const callbackData = buildModelSelectionCallbackData({
      provider,
      model,
      sortedIndex,
    });
    // Skip only if every encoding (standard, compact, index) exceeds the
    // 64-byte limit. In practice the index encoding fits for any reasonable
    // provider id, so models are no longer dropped for long names.
    if (!callbackData) {
      continue;
    }

    const isCurrentModel = isCurrentModelSelection({ currentModel, provider, model });
    const fallbackLabel = model.includes("/") ? `${provider}/${model}` : model;
    const displayLabel = modelNames?.get(`${provider}/${model}`) ?? fallbackLabel;
    const displayText = truncateModelId(displayLabel, 38);
    const text = isCurrentModel ? `${displayText} ✓` : displayText;

    rows.push([
      {
        text,
        callback_data: callbackData,
      },
    ]);
  }

  // Pagination row
  if (totalPages > 1) {
    const paginationRow: ButtonRow = [];

    if (currentPage > 1) {
      paginationRow.push({
        text: "◀ Prev",
        callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage - 1}`,
      });
    }

    paginationRow.push({
      text: `${currentPage}/${totalPages}`,
      callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage}`, // noop
    });

    if (currentPage < totalPages) {
      paginationRow.push({
        text: "Next ▶",
        callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage + 1}`,
      });
    }

    rows.push(paginationRow);
  }

  // Back button
  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]);

  return rows;
}

/**
 * Build "Browse providers" button for /model summary.
 */
export function buildBrowseProvidersButton(): ButtonRow[] {
  return [[{ text: "Browse providers", callback_data: CALLBACK_PREFIX.providers }]];
}

/**
 * Truncate model ID for display, preserving end if too long.
 */
function truncateModelId(modelId: string, maxLen: number): string {
  if (modelId.length <= maxLen) {
    return modelId;
  }
  // Show last part with ellipsis prefix
  return `…${modelId.slice(-(maxLen - 1))}`;
}

/**
 * Get page size for model list pagination.
 */
export function getModelsPageSize(): number {
  return MODELS_PAGE_SIZE;
}

/**
 * Calculate total pages for a model list.
 */
export function calculateTotalPages(totalModels: number, pageSize?: number): number {
  const size = pageSize ?? MODELS_PAGE_SIZE;
  return size > 0 ? Math.ceil(totalModels / size) : 1;
}
