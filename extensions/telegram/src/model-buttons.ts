/**
 * Telegram inline button utilities for model selection.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_prov              - show providers list
 * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
 * - mdl_sel_{provider/id} - select model (standard)
 * - mdl_sel/{model}       - read legacy providerless model selections
 * - mdl_rt_{runtime}_{provider/id} - select model on an explicit runtime
 * - mdl1~r:{sha256}       - select an opaque provider/model/runtime triple
 * - mdl1~m:{sha256}       - select an opaque provider/model ref
 * - mdl1~p:{sha256}:{pg}  - show models for an opaque provider ref
 * - mdl_back              - back to providers list
 */
import { createHash } from "node:crypto";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { fitsTelegramCallbackData } from "./approval-callback-data.js";

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export type ParsedModelCallback =
  | { type: "providers" }
  | { type: "list"; provider: string; page: number }
  | { type: "list-ref"; digest: string; page: number }
  | { type: "select"; provider?: string; model: string }
  | { type: "select-ref"; digest: string }
  | { type: "select-runtime"; provider: string; model: string; runtime: string }
  | { type: "select-runtime-ref"; digest: string }
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
  /** Runtime choices per provider/model, default runtime first. A model with
   *  variants gets one button per runtime instead of a single button. */
  runtimeVariants?: ReadonlyMap<string, readonly ModelRuntimeVariant[]>;
  /** Plain model names (without route prefix) used for runtime variant labels. */
  baseModelNames?: ReadonlyMap<string, string>;
  /** Runtime the session currently uses; marks the matching variant. */
  currentRuntime?: string;
};

export type ModelRuntimeVariant = {
  runtime: string;
  /** Short route label shown before the model name, e.g. "API" or "Claude CLI". */
  label: string;
};

/** One button in the model list: a model, optionally pinned to a runtime. */
export type ModelListEntry = {
  model: string;
  variant?: ModelRuntimeVariant;
};

const MODELS_PAGE_SIZE = 8;
const MODEL_BUTTON_LABEL_MAX_LENGTH = 38;
const MIN_VARIANT_MODEL_LABEL_LENGTH = 12;
const LEGACY_PROVIDER_PATTERN = /^[a-z0-9_.-]+$/i;
const CALLBACK_PREFIX = {
  providers: "mdl_prov",
  back: "mdl_back",
  list: "mdl_list_",
  selectStandard: "mdl_sel_",
  opaqueModel: "mdl1~m:",
  opaqueProvider: "mdl1~p:",
  selectRuntime: "mdl_rt_",
  opaqueRuntimeModel: "mdl1~r:",
} as const;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function hashOpaqueCallback(
  domain: "model" | "provider" | "runtime-model",
  ...values: string[]
): string {
  return createHash("sha256")
    .update(JSON.stringify([`openclaw.telegram.${domain}-callback.v1`, ...values]))
    .digest("base64url");
}

export function parseModelCallbackData(data: string): ParsedModelCallback | null {
  const trimmed = data.trim();
  const opaqueModelMatch = trimmed.match(/^mdl1~m:([A-Za-z0-9_-]{43})$/);
  if (opaqueModelMatch?.[1]) {
    return { type: "select-ref", digest: opaqueModelMatch[1] };
  }
  const opaqueRuntimeMatch = trimmed.match(/^mdl1~r:([A-Za-z0-9_-]{43})$/);
  if (opaqueRuntimeMatch?.[1]) {
    return { type: "select-runtime-ref", digest: opaqueRuntimeMatch[1] };
  }
  const runtimeMatch = trimmed.match(/^mdl_rt_([a-z][a-z0-9-]*)_([^/]+)\/(.+)$/);
  if (runtimeMatch?.[1] && runtimeMatch[2] && runtimeMatch[3]) {
    return {
      type: "select-runtime",
      runtime: runtimeMatch[1],
      provider: runtimeMatch[2],
      model: runtimeMatch[3],
    };
  }
  const opaqueProviderMatch = trimmed.match(/^mdl1~p:([A-Za-z0-9_-]{43}):(\d+)$/);
  if (opaqueProviderMatch?.[1]) {
    const page = parseStrictPositiveInteger(opaqueProviderMatch[2]);
    if (page !== undefined && fitsTelegramCallbackData(trimmed)) {
      return { type: "list-ref", digest: opaqueProviderMatch[1], page };
    }
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

  // mdl_sel/{model} (legacy providerless input)
  const compactModel = trimmed.match(/^mdl_sel\/(.+)$/)?.[1];
  if (compactModel) {
    return { type: "select", model: compactModel };
  }

  // mdl_sel_{provider/model}
  const [, provider, model] = trimmed.match(/^mdl_sel_([^/]+)\/(.+)$/) ?? [];
  return provider && model ? { type: "select", provider, model } : null;
}

export function buildModelSelectionCallbackData(params: {
  provider: string;
  model: string;
}): string {
  const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
  if (LEGACY_PROVIDER_PATTERN.test(params.provider) && fitsTelegramCallbackData(fullCallbackData)) {
    return fullCallbackData;
  }
  return `${CALLBACK_PREFIX.opaqueModel}${hashOpaqueCallback("model", params.provider, params.model)}`;
}

/** Callback data selecting a model on an explicit runtime. */
function buildModelRuntimeSelectionCallbackData(params: {
  provider: string;
  model: string;
  runtime: string;
}): string {
  const fullCallbackData = `${CALLBACK_PREFIX.selectRuntime}${params.runtime}_${params.provider}/${params.model}`;
  if (
    RUNTIME_ID_PATTERN.test(params.runtime) &&
    LEGACY_PROVIDER_PATTERN.test(params.provider) &&
    fitsTelegramCallbackData(fullCallbackData)
  ) {
    return fullCallbackData;
  }
  return `${CALLBACK_PREFIX.opaqueRuntimeModel}${hashOpaqueCallback("runtime-model", params.provider, params.model, params.runtime)}`;
}

/**
 * Resolves a runtime selection against the offered variants only, so a stale
 * or forged callback cannot pick a runtime the picker did not show.
 */
export function resolveModelRuntimeSelection(params: {
  callback: Extract<ParsedModelCallback, { type: "select-runtime" | "select-runtime-ref" }>;
  providers: readonly string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  runtimeVariants: ReadonlyMap<string, readonly ModelRuntimeVariant[]>;
}): { provider: string; model: string; runtime: string } | undefined {
  const { callback } = params;
  const offered = (provider: string, model: string, runtime: string) =>
    params.byProvider.get(provider)?.has(model) === true &&
    (params.runtimeVariants.get(`${provider}/${model}`) ?? []).some(
      (variant) => variant.runtime === runtime,
    );
  if (callback.type === "select-runtime") {
    return offered(callback.provider, callback.model, callback.runtime)
      ? { provider: callback.provider, model: callback.model, runtime: callback.runtime }
      : undefined;
  }
  const matches = params.providers.flatMap((provider) =>
    [...(params.byProvider.get(provider) ?? [])].flatMap((model) =>
      (params.runtimeVariants.get(`${provider}/${model}`) ?? [])
        .filter(
          (variant) =>
            hashOpaqueCallback("runtime-model", provider, model, variant.runtime) ===
            callback.digest,
        )
        .map((variant) => ({ provider, model, runtime: variant.runtime })),
    ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Expands models into picker entries: one per runtime variant where offered. */
export function expandModelEntries(
  provider: string,
  models: readonly string[],
  runtimeVariants?: ReadonlyMap<string, readonly ModelRuntimeVariant[]>,
): ModelListEntry[] {
  return models.flatMap((model) => {
    const variants = runtimeVariants?.get(`${provider}/${model}`);
    return variants && variants.length > 1
      ? variants.map((variant) => ({ model, variant }))
      : [{ model }];
  });
}

function buildProviderListCallbackData(provider: string, page: number): string {
  const callbackData = `${CALLBACK_PREFIX.list}${provider}_${page}`;
  return LEGACY_PROVIDER_PATTERN.test(provider) && fitsTelegramCallbackData(callbackData)
    ? callbackData
    : `${CALLBACK_PREFIX.opaqueProvider}${hashOpaqueCallback("provider", provider)}:${page}`;
}

export function resolveModelSelection(params: {
  callback: Extract<ParsedModelCallback, { type: "select" | "select-ref" }>;
  providers: readonly string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): ResolveModelSelectionResult {
  const callback = params.callback;
  if (callback.type === "select" && callback.provider) {
    return {
      kind: "resolved",
      provider: callback.provider,
      model: callback.model,
    };
  }
  const matches = params.providers.flatMap((provider) => {
    const models = params.byProvider.get(provider);
    if (callback.type === "select") {
      return models?.has(callback.model) ? [{ provider, model: callback.model }] : [];
    }
    return [...(models ?? [])]
      .filter((model) => hashOpaqueCallback("model", provider, model) === callback.digest)
      .map((model) => ({ provider, model }));
  });
  const [match] = matches;
  return matches.length === 1 && match
    ? { kind: "resolved", ...match }
    : {
        kind: "ambiguous",
        model: callback.type === "select" ? callback.model : callback.digest,
        matchingProviders: matches.map(({ provider }) => provider),
      };
}

export function resolveModelListCallback(params: {
  callback: Extract<ParsedModelCallback, { type: "list" | "list-ref" }>;
  providers: readonly string[];
}): { provider: string; page: number } | undefined {
  const { callback } = params;
  if (callback.type === "list") {
    return { provider: callback.provider, page: callback.page };
  }
  const matches = params.providers.filter(
    (provider) => hashOpaqueCallback("provider", provider) === callback.digest,
  );
  const [provider] = matches;
  return matches.length === 1 && provider !== undefined
    ? { provider, page: callback.page }
    : undefined;
}

export function buildProviderKeyboard(providers: ProviderInfo[]): ButtonRow[] {
  const rows: ButtonRow[] = [];
  for (const [index, provider] of providers.entries()) {
    (rows[Math.floor(index / 2)] ??= []).push({
      text: `${provider.id} (${provider.count})`,
      callback_data: buildProviderListCallbackData(provider.id, 1),
    });
  }
  return rows;
}

export function buildModelsKeyboard(params: ModelsKeyboardParams): ButtonRow[] {
  const { provider, models, currentModel, currentPage, totalPages, modelNames } = params;
  const currentSelection = currentModel?.trim() ?? "";
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;

  if (models.length === 0) {
    return [[{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]];
  }

  const rows: ButtonRow[] = [];

  const entries = expandModelEntries(provider, models, params.runtimeVariants);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, entries.length);
  const pageEntries = entries.slice(startIndex, endIndex);

  for (const { model, variant } of pageEntries) {
    const key = `${provider}/${model}`;
    const callbackData = variant
      ? buildModelRuntimeSelectionCallbackData({ provider, model, runtime: variant.runtime })
      : buildModelSelectionCallbackData({ provider, model });
    const isCurrentModel =
      currentSelection.length > 0 &&
      currentSelection === (currentSelection.includes("/") ? key : model) &&
      (!variant ||
        variant.runtime ===
          (params.currentRuntime ?? params.runtimeVariants?.get(key)?.[0]?.runtime));
    const fallbackLabel = model.includes("/") ? `${provider}/${model}` : model;
    // Runtime variants truncate only the model part, so "API · …" and
    // "Claude CLI · …" stay distinguishable for long model names.
    const displayText = variant
      ? truncateRuntimeVariantLabel(
          variant.label,
          params.baseModelNames?.get(key) ?? fallbackLabel,
          MODEL_BUTTON_LABEL_MAX_LENGTH,
        )
      : truncateModelLabel(modelNames?.get(key) ?? fallbackLabel, MODEL_BUTTON_LABEL_MAX_LENGTH);
    const text = isCurrentModel ? `${displayText} ✓` : displayText;

    rows.push([
      {
        text,
        callback_data: callbackData,
      },
    ]);
  }

  if (totalPages > 1) {
    const paginationRow: ButtonRow = [];

    if (currentPage > 1) {
      paginationRow.push({
        text: "◀ Prev",
        callback_data: buildProviderListCallbackData(provider, currentPage - 1),
      });
    }

    paginationRow.push({
      text: `${currentPage}/${totalPages}`,
      callback_data: buildProviderListCallbackData(provider, currentPage), // noop
    });

    if (currentPage < totalPages) {
      paginationRow.push({
        text: "Next ▶",
        callback_data: buildProviderListCallbackData(provider, currentPage + 1),
      });
    }

    rows.push(paginationRow);
  }

  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]);

  return rows;
}

export function buildBrowseProvidersButton(): ButtonRow[] {
  return [[{ text: "Browse providers", callback_data: CALLBACK_PREFIX.providers }]];
}

function truncateModelLabel(modelLabel: string, maxLen: number): string {
  if (modelLabel.length <= maxLen) {
    return modelLabel;
  }
  return `…${sliceUtf16Safe(modelLabel, -(maxLen - 1))}`;
}

function truncateRuntimeVariantLabel(
  runtimeLabel: string,
  modelLabel: string,
  maxLen: number,
): string {
  const prefix = `${runtimeLabel} · `;
  return `${prefix}${truncateModelLabel(modelLabel, Math.max(MIN_VARIANT_MODEL_LABEL_LENGTH, maxLen - prefix.length))}`;
}

export function getModelsPageSize(): number {
  return MODELS_PAGE_SIZE;
}

export function calculateTotalPages(totalModels: number, pageSize?: number): number {
  const size = pageSize ?? MODELS_PAGE_SIZE;
  return size > 0 ? Math.ceil(totalModels / size) : 1;
}
