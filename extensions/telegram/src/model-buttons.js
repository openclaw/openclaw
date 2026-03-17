const MODELS_PAGE_SIZE = 8;
const MAX_CALLBACK_DATA_BYTES = 64;
const CALLBACK_PREFIX = {
  providers: "mdl_prov",
  back: "mdl_back",
  list: "mdl_list_",
  selectStandard: "mdl_sel_",
  selectCompact: "mdl_sel/"
};
function parseModelCallbackData(data) {
  const trimmed = data.trim();
  if (!trimmed.startsWith("mdl_")) {
    return null;
  }
  if (trimmed === CALLBACK_PREFIX.providers || trimmed === CALLBACK_PREFIX.back) {
    return { type: trimmed === CALLBACK_PREFIX.providers ? "providers" : "back" };
  }
  const listMatch = trimmed.match(/^mdl_list_([a-z0-9_-]+)_(\d+)$/i);
  if (listMatch) {
    const [, provider, pageStr] = listMatch;
    const page = Number.parseInt(pageStr ?? "1", 10);
    if (provider && Number.isFinite(page) && page >= 1) {
      return { type: "list", provider, page };
    }
  }
  const compactSelMatch = trimmed.match(/^mdl_sel\/(.+)$/);
  if (compactSelMatch) {
    const modelRef = compactSelMatch[1];
    if (modelRef) {
      return {
        type: "select",
        model: modelRef
      };
    }
  }
  const selMatch = trimmed.match(/^mdl_sel_(.+)$/);
  if (selMatch) {
    const modelRef = selMatch[1];
    if (modelRef) {
      const slashIndex = modelRef.indexOf("/");
      if (slashIndex > 0 && slashIndex < modelRef.length - 1) {
        return {
          type: "select",
          provider: modelRef.slice(0, slashIndex),
          model: modelRef.slice(slashIndex + 1)
        };
      }
    }
  }
  return null;
}
function buildModelSelectionCallbackData(params) {
  const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
  if (Buffer.byteLength(fullCallbackData, "utf8") <= MAX_CALLBACK_DATA_BYTES) {
    return fullCallbackData;
  }
  const compactCallbackData = `${CALLBACK_PREFIX.selectCompact}${params.model}`;
  return Buffer.byteLength(compactCallbackData, "utf8") <= MAX_CALLBACK_DATA_BYTES ? compactCallbackData : null;
}
function resolveModelSelection(params) {
  if (params.callback.provider) {
    return {
      kind: "resolved",
      provider: params.callback.provider,
      model: params.callback.model
    };
  }
  const matchingProviders = params.providers.filter(
    (id) => params.byProvider.get(id)?.has(params.callback.model)
  );
  if (matchingProviders.length === 1) {
    return {
      kind: "resolved",
      provider: matchingProviders[0],
      model: params.callback.model
    };
  }
  return {
    kind: "ambiguous",
    model: params.callback.model,
    matchingProviders
  };
}
function buildProviderKeyboard(providers) {
  if (providers.length === 0) {
    return [];
  }
  const rows = [];
  let currentRow = [];
  for (const provider of providers) {
    const button = {
      text: `${provider.id} (${provider.count})`,
      callback_data: `mdl_list_${provider.id}_1`
    };
    currentRow.push(button);
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
function buildModelsKeyboard(params) {
  const { provider, models, currentModel, currentPage, totalPages } = params;
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;
  if (models.length === 0) {
    return [[{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]];
  }
  const rows = [];
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);
  const currentModelId = currentModel?.includes("/") ? currentModel.split("/").slice(1).join("/") : currentModel;
  for (const model of pageModels) {
    const callbackData = buildModelSelectionCallbackData({ provider, model });
    if (!callbackData) {
      continue;
    }
    const isCurrentModel = model === currentModelId;
    const displayText = truncateModelId(model, 38);
    const text = isCurrentModel ? `${displayText} \u2713` : displayText;
    rows.push([
      {
        text,
        callback_data: callbackData
      }
    ]);
  }
  if (totalPages > 1) {
    const paginationRow = [];
    if (currentPage > 1) {
      paginationRow.push({
        text: "\u25C0 Prev",
        callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage - 1}`
      });
    }
    paginationRow.push({
      text: `${currentPage}/${totalPages}`,
      callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage}`
      // noop
    });
    if (currentPage < totalPages) {
      paginationRow.push({
        text: "Next \u25B6",
        callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage + 1}`
      });
    }
    rows.push(paginationRow);
  }
  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]);
  return rows;
}
function buildBrowseProvidersButton() {
  return [[{ text: "Browse providers", callback_data: CALLBACK_PREFIX.providers }]];
}
function truncateModelId(modelId, maxLen) {
  if (modelId.length <= maxLen) {
    return modelId;
  }
  return `\u2026${modelId.slice(-(maxLen - 1))}`;
}
function getModelsPageSize() {
  return MODELS_PAGE_SIZE;
}
function calculateTotalPages(totalModels, pageSize) {
  const size = pageSize ?? MODELS_PAGE_SIZE;
  return size > 0 ? Math.ceil(totalModels / size) : 1;
}
export {
  buildBrowseProvidersButton,
  buildModelSelectionCallbackData,
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection
};
