/**
 * Telegram inline button utilities for model selection.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_prov                      - show providers list
 * - mdl_list_{prov}_{pg}          - show models for provider (page N, 1-indexed)
 * - mdl_sel_{prov}_{pg}_{idx}     - select model by page + absolute index
 * - mdl_back                      - back to providers list
 *
 * The index-based select format avoids the 64-byte callback_data limit:
 * model names are never embedded in the button data (#98221).
 */
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export type ParsedModelCallback =
  | { type: "providers" }
  | { type: "list"; provider: string; page: number }
  | {
      type: "select";
      provider?: string;
      page: number;
      modelIndex: number;
      totalCount: number;
      fingerprint?: string;
      model?: string;
    }
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
const MODEL_BUTTON_LABEL_MAX_LENGTH = 38;
const CALLBACK_PREFIX = {
  providers: "mdl_prov",
  back: "mdl_back",
  list: "mdl_list_",
  select: "mdl_sel_",
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

  // mdl_sel_{provider}_{page}_{modelIndex}_{totalCount}[_{fingerprint}]  (1-based)
  const idxMatch = trimmed.match(/^mdl_sel_([a-z0-9_.-]+)_(\d+)_(\d+)_(\d+)(?:_([a-f0-9]{4}))?$/i);
  if (idxMatch) {
    const [, provider, pageStr, idxStr, totalStr, fingerprint] = idxMatch;
    const page = parseStrictPositiveInteger(pageStr);
    const modelIndex = parseStrictPositiveInteger(idxStr);
    const totalCount = parseStrictPositiveInteger(totalStr);
    if (provider && page !== undefined && modelIndex !== undefined && totalCount !== undefined) {
      return {
        type: "select",
        provider,
        page,
        modelIndex,
        totalCount,
        fingerprint: fingerprint || undefined,
      };
    }
  }

  // Legacy formats (backward compat for in-flight buttons rendered before the index scheme):
  // mdl_sel/{model} (compact)
  const compactMatch = trimmed.match(/^mdl_sel\/(.+)$/);
  if (compactMatch) {
    const modelRef = compactMatch[1];
    if (modelRef) {
      return { type: "select", page: 1, modelIndex: 0, totalCount: 0, model: modelRef };
    }
  }

  // mdl_sel_{provider/model} (standard)
  const selMatch = trimmed.match(/^mdl_sel_(.+)$/);
  if (selMatch) {
    const modelRef = selMatch[1];
    if (modelRef) {
      const slashIndex = modelRef.indexOf("/");
      if (slashIndex > 0 && slashIndex < modelRef.length - 1) {
        return {
          type: "select",
          provider: modelRef.slice(0, slashIndex),
          page: 1,
          modelIndex: 0,
          totalCount: 0,
          model: modelRef.slice(slashIndex + 1),
        };
      }
    }
  }

  return null;
}

/**
 * Compute a short fingerprint of the model list for stale-button detection.
 * Catches same-count-but-different-content changes that totalCount alone misses.
 */
function computeModelListFingerprint(sortedModels: readonly string[]): string {
  // Rolling hash over model names separated by a delimiter so that
  // ["ab","c"] and ["a","bc"] produce different fingerprints.
  let hash = 0;
  for (const name of sortedModels) {
    for (let i = 0; i < name.length; i++) {
      hash = (hash << 5) - hash + name.charCodeAt(i);
      hash |= 0;
    }
    // Delimiter between model names prevents concatenation ambiguity
    hash = (hash << 5) - hash + 0x7c; // '|'
    hash |= 0;
  }
  return (hash >>> 0).toString(16).slice(0, 4);
}

export function buildModelSelectionCallbackData(params: {
  provider: string;
  page: number;
  modelIndex: number;
  totalCount: number;
  models: readonly string[];
}): string {
  // Fixed-length callback (page, modelIndex, totalCount are 1-based).
  // Never embeds model names, always fits in 64 bytes (#98221).
  // totalCount + fingerprint guard against stale buttons: if the provider's
  // model list changes between render and click, the mismatch is detected.
  const snapshot = computeModelListFingerprint(params.models);
  return `${CALLBACK_PREFIX.select}${params.provider}_${params.page}_${params.modelIndex}_${params.totalCount}_${snapshot}`;
}

export function resolveModelSelection(params: {
  callback: Extract<ParsedModelCallback, { type: "select" }>;
  providers: readonly string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): ResolveModelSelectionResult {
  const { provider, modelIndex, totalCount, model: legacyModel } = params.callback;

  // Legacy callback (pre-index format): resolve by model name across providers.
  if (legacyModel) {
    if (provider) {
      return { kind: "resolved", provider, model: legacyModel };
    }
    const matchingProviders = params.providers.filter((id) =>
      params.byProvider.get(id)?.has(legacyModel),
    );
    if (matchingProviders.length === 1) {
      return {
        kind: "resolved",
        provider: expectDefined(matchingProviders.at(0), "single matching model provider"),
        model: legacyModel,
      };
    }
    return { kind: "ambiguous", model: legacyModel, matchingProviders };
  }

  // Index-based callback: resolve by provider + index, with stale guards.
  if (!provider) {
    return { kind: "ambiguous", model: "", matchingProviders: [...params.providers] };
  }
  const models = params.byProvider.get(provider);
  if (!models || models.size === 0) {
    return { kind: "ambiguous", model: "", matchingProviders: [...params.providers] };
  }
  if (totalCount > 0) {
    // Reject stale buttons via count mismatch (add/remove detected).
    if (models.size !== totalCount) {
      return { kind: "ambiguous", model: "", matchingProviders: [...params.providers] };
    }
    // Reject stale buttons via fingerprint mismatch (same-count-different-content).
    const sorted = [...models].toSorted((a, b) => a.localeCompare(b));
    const expectedFingerprint = computeModelListFingerprint(sorted);
    if (params.callback.fingerprint && params.callback.fingerprint !== expectedFingerprint) {
      return { kind: "ambiguous", model: "", matchingProviders: [...params.providers] };
    }
    const model = sorted[modelIndex - 1]; // modelIndex is 1-based
    if (!model) {
      return { kind: "ambiguous", model: "", matchingProviders: [...params.providers] };
    }
    return { kind: "resolved", provider, model };
  }
  // totalCount === 0 means legacy callback with model name — handled above.
  return { kind: "ambiguous", model: "", matchingProviders: [...params.providers] };
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

  for (const [pageIdx, model] of pageModels.entries()) {
    const modelIndex = startIndex + pageIdx + 1; // 1-based absolute index in sorted models (#98221)
    const callbackData = buildModelSelectionCallbackData({
      provider,
      page: currentPage,
      modelIndex,
      totalCount: models.length,
      models, // snapshot for stale-button detection
    });

    const isCurrentModel = isCurrentModelSelection({ currentModel, provider, model });
    const fallbackLabel = model.includes("/") ? `${provider}/${model}` : model;
    const displayLabel = modelNames?.get(`${provider}/${model}`) ?? fallbackLabel;
    const displayText = truncateModelLabel(displayLabel, MODEL_BUTTON_LABEL_MAX_LENGTH);
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
 * Truncate a model label for display, preserving its end if too long.
 */
function truncateModelLabel(modelLabel: string, maxLen: number): string {
  if (modelLabel.length <= maxLen) {
    return modelLabel;
  }
  return `…${sliceUtf16Safe(modelLabel, -(maxLen - 1))}`;
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
