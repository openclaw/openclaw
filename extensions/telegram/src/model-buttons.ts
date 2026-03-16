/**
 * Telegram inline button utilities for model selection.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_prov              - show providers list
 * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
 * - mdl_sel_{provider/id} - select model (standard)
 * - mdl_sel/{model}       - select model (compact fallback when standard is >64 bytes)
 * - mdl_back              - back to providers list
 *
 * Same patterns with prefix "nm_" for narrative model picker,
 * and "gm_" for graphiti/observer model picker.
 */

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export type ParsedModelCallback =
  | { type: "providers" }
  | { type: "list"; provider: string; page: number }
  | { type: "select"; provider?: string; model: string }
  | { type: "back" };

/** Which config key a model picker targets. */
export type ModelPickerTarget = "main" | "narrative" | "graphiti";

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
};

const MODELS_PAGE_SIZE = 8;
const MAX_CALLBACK_DATA_BYTES = 64;
const CALLBACK_PREFIX = {
  providers: "mdl_prov",
  back: "mdl_back",
  list: "mdl_list_",
  selectStandard: "mdl_sel_",
  selectCompact: "mdl_sel/",
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
  const listMatch = trimmed.match(/^mdl_list_([a-z0-9_-]+)_(\d+)$/i);
  if (listMatch) {
    const [, provider, pageStr] = listMatch;
    const page = Number.parseInt(pageStr ?? "1", 10);
    if (provider && Number.isFinite(page) && page >= 1) {
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
}): string | null {
  const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
  if (Buffer.byteLength(fullCallbackData, "utf8") <= MAX_CALLBACK_DATA_BYTES) {
    return fullCallbackData;
  }
  const compactCallbackData = `${CALLBACK_PREFIX.selectCompact}${params.model}`;
  return Buffer.byteLength(compactCallbackData, "utf8") <= MAX_CALLBACK_DATA_BYTES
    ? compactCallbackData
    : null;
}

export function resolveModelSelection(params: {
  callback: Extract<ParsedModelCallback, { type: "select" }>;
  providers: readonly string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): ResolveModelSelectionResult {
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
  const { provider, models, currentModel, currentPage, totalPages } = params;
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;

  if (models.length === 0) {
    return [[{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]];
  }

  const rows: ButtonRow[] = [];

  // Calculate page slice
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);

  // Model buttons - one per row
  const currentModelId = currentModel?.includes("/")
    ? currentModel.split("/").slice(1).join("/")
    : currentModel;

  for (const model of pageModels) {
    const callbackData = buildModelSelectionCallbackData({ provider, model });
    // Skip models that still exceed Telegram's callback_data limit.
    if (!callbackData) {
      continue;
    }

    const isCurrentModel = model === currentModelId;
    const displayText = truncateModelId(model, 38);
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

// ---------------------------------------------------------------------------
// Auxiliary model pickers (narrative = "nm_", graphiti = "gm_")
// Same shape as the main model picker but stored in different config keys.
// ---------------------------------------------------------------------------

const TARGET_PREFIX: Record<Exclude<ModelPickerTarget, "main">, string> = {
  narrative: "nm",
  graphiti: "gm",
};

export type ParsedAuxModelCallback = ParsedModelCallback & {
  target: Exclude<ModelPickerTarget, "main">;
};

/**
 * Parse a narrative ("nm_*") or graphiti ("gm_*") model callback.
 * Returns null if not a known aux-model pattern.
 */
export function parseAuxModelCallbackData(data: string): ParsedAuxModelCallback | null {
  const trimmed = data.trim();
  for (const [target, prefix] of Object.entries(TARGET_PREFIX) as [
    Exclude<ModelPickerTarget, "main">,
    string,
  ][]) {
    if (!trimmed.startsWith(`${prefix}_`)) {
      continue;
    }
    // Reuse the main parser by replacing the prefix
    const mainStyle = "mdl" + trimmed.slice(prefix.length);
    const parsed = parseModelCallbackData(mainStyle);
    if (parsed) {
      return { ...parsed, target };
    }
  }
  return null;
}

/**
 * Build provider keyboard for an aux model picker (narrative or graphiti).
 */
export function buildAuxProviderKeyboard(
  providers: ProviderInfo[],
  target: Exclude<ModelPickerTarget, "main">,
): ButtonRow[] {
  const prefix = TARGET_PREFIX[target];
  if (providers.length === 0) {
    return [];
  }

  const rows: ButtonRow[] = [];
  let currentRow: ButtonRow = [];
  for (const provider of providers) {
    currentRow.push({
      text: `${provider.id} (${provider.count})`,
      callback_data: `${prefix}_list_${provider.id}_1`,
    });
    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }
  return rows;
}

/**
 * Build model list keyboard for an aux model picker (narrative or graphiti).
 */
export function buildAuxModelsKeyboard(
  params: ModelsKeyboardParams,
  target: Exclude<ModelPickerTarget, "main">,
): ButtonRow[] {
  const prefix = TARGET_PREFIX[target];
  const { provider, models, currentModel, currentPage, totalPages } = params;
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;

  if (models.length === 0) {
    return [[{ text: "<< Back", callback_data: `${prefix}_back` }]];
  }

  const rows: ButtonRow[] = [];
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);

  const currentModelId = currentModel?.includes("/")
    ? currentModel.split("/").slice(1).join("/")
    : currentModel;

  for (const model of pageModels) {
    const callbackData = `${prefix}_sel_${provider}/${model}`;
    if (Buffer.byteLength(callbackData, "utf8") > MAX_CALLBACK_DATA_BYTES) {
      continue;
    }
    const isCurrentModel = model === currentModelId;
    const displayText = truncateModelId(model, 38);
    rows.push([
      { text: isCurrentModel ? `${displayText} ✓` : displayText, callback_data: callbackData },
    ]);
  }

  if (totalPages > 1) {
    const paginationRow: ButtonRow = [];
    if (currentPage > 1) {
      paginationRow.push({
        text: "◀ Prev",
        callback_data: `${prefix}_list_${provider}_${currentPage - 1}`,
      });
    }
    paginationRow.push({
      text: `${currentPage}/${totalPages}`,
      callback_data: `${prefix}_list_${provider}_${currentPage}`,
    });
    if (currentPage < totalPages) {
      paginationRow.push({
        text: "Next ▶",
        callback_data: `${prefix}_list_${provider}_${currentPage + 1}`,
      });
    }
    rows.push(paginationRow);
  }

  rows.push([{ text: "<< Back", callback_data: `${prefix}_back` }]);
  return rows;
}
