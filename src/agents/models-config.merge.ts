import type { ModelDefinitionConfig } from "../config/types.models.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

export type ExistingProviderConfig = ProviderConfig & {
  apiKey?: string;
  baseUrl?: string;
  api?: string;
};

function isPositiveFiniteTokenLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolvePreferredTokenLimit(params: {
  explicitPresent: boolean;
  explicitValue: unknown;
  implicitValue: unknown;
}): number | undefined {
  if (params.explicitPresent && isPositiveFiniteTokenLimit(params.explicitValue)) {
    return params.explicitValue;
  }
  if (isPositiveFiniteTokenLimit(params.implicitValue)) {
    return params.implicitValue;
  }
  return isPositiveFiniteTokenLimit(params.explicitValue) ? params.explicitValue : undefined;
}

function getProviderModelId(model: unknown): string {
  if (!model || typeof model !== "object") {
    return "";
  }
  const id = (model as { id?: unknown }).id;
  return normalizeOptionalString(id) ?? "";
}

/**
 * Provider IDs that are shipped as first-party / built-in catalog entries by
 * OpenClaw's bundled extension plugins.  The input-capability default logic is
 * restricted to these providers so that user-defined custom provider proxies
 * (which may reuse a well-known model name such as "claude-3-5-sonnet" but
 * route to an endpoint that never declared image support) are never silently
 * upgraded to image-capable.  Custom providers MUST opt in explicitly by
 * setting `input: ["text", "image"]` on the model entry.
 *
 * Derived from the `PROVIDER_ID` constants in each extension's index.ts and the
 * `hookAliases` registered in the built-in provider plugins.
 */
export const BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "azure-openai",
  "azure-openai-responses",
  "google",
  "google-vertex",
  "google-antigravity",
  "google-gemini-cli",
  "anthropic-vertex",
  "amazon-bedrock",
  "groq",
  "openrouter",
  "together",
  "fireworks",
  "deepseek",
  "mistral",
  "qwen",
  "xai",
  "deepinfra",
  "cerebras",
  "moonshot",
  "kimi",
  "volcengine",
  "nvidia",
  "minimax",
  "zai",
  "codex",
  "kilocode",
  "opencode",
  "opencode-go",
  "arcee",
  "venice",
  "chutes",
  "byteplus",
  "stepfun",
  "perplexity",
]);

/**
 * Default `input` modalities for explicit model entries that don't specify
 * one and have no matching implicit (discovery) entry to inherit from.
 *
 * Without this, models silently default to text-only at query time,
 * which silently breaks image attachments for Claude 3.5+ / 4.x, GPT-4o,
 * Gemini 1.5+, and every other modern vision-capable model whose explicit
 * entry was authored before `input` became required.
 *
 * Kept conservative: only adds "image" for ID patterns that are
 * known-vision-capable. Anything else stays undefined (which downstream
 * still treats as text-only, matching prior behavior).
 */
const VISION_CAPABLE_ID_PATTERNS: readonly RegExp[] = [
  // Anthropic Claude 3.5+, 3.7, 4.x (dot and dash variants, all regions/profiles)
  /claude-(?:3-5|3\.5|3-7|3\.7|opus-4|sonnet-4|haiku-4|4-\d)/i,
  // OpenAI multimodal families: gpt-4o / 4.1 / 4-turbo / 5 and the o-series
  // (o1, o3, o4). The o-series alternatives are anchored to a start / slash
  // prefix so they only match model-name tokens like "o1", "o1-mini",
  // "openai/o3-pro", or "o4-mini" — not arbitrary substrings like
  // "nova-pro-o4-v1" or "fo1-embed".
  /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|(?:^|\/)(?:o1|o3|o4)(?:$|-)/i,
  // Google multimodal families
  /gemini-(?:1\.5|2|2\.5|pro-vision)/i,
  // Meta vision-specific variants. Llama 3.2 ships vision only in the 11B /
  // 90B "vision" SKUs; the small 1B / 3B "instruct" SKUs are text-only, so we
  // only flag IDs that explicitly mark a vision variant.
  /llama-(?:3\.2|4)[^\s]*vision/i,
];

function explicitEntryLooksVisionCapable(id: string): boolean {
  if (!id) {
    return false;
  }
  return VISION_CAPABLE_ID_PATTERNS.some((re) => re.test(id));
}

function applyInputDefaultForExplicitOnlyEntry(
  entry: ModelDefinitionConfig,
  opts?: { builtInProvider?: boolean },
): ModelDefinitionConfig {
  const id = getProviderModelId(entry);
  const existing = (entry as { input?: unknown }).input;
  if (Array.isArray(existing)) {
    return entry;
  }
  // Only infer image capability for known built-in provider catalogs.  A
  // custom provider endpoint that happens to use a well-known model ID (e.g.
  // "claude-3-5-sonnet" behind a company proxy) must declare
  // `input: ["text", "image"]` explicitly; we must not silently forward
  // attachments to endpoints that never advertised image support.
  if (!opts?.builtInProvider) {
    return entry;
  }
  if (!explicitEntryLooksVisionCapable(id)) {
    return entry;
  }
  return { ...entry, input: ["text", "image"] };
}

export function mergeProviderModels(
  implicit: ProviderConfig,
  explicit: ProviderConfig,
  opts?: { providerKey?: string },
): ProviderConfig {
  const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
  const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
  const implicitHeaders =
    implicit.headers && typeof implicit.headers === "object" && !Array.isArray(implicit.headers)
      ? implicit.headers
      : undefined;
  const explicitHeaders =
    explicit.headers && typeof explicit.headers === "object" && !Array.isArray(explicit.headers)
      ? explicit.headers
      : undefined;
  const builtInProvider =
    opts?.providerKey !== undefined
      ? BUILT_IN_PROVIDER_IDS.has(normalizeOptionalString(opts.providerKey) ?? "")
      : false;
  if (implicitModels.length === 0) {
    const explicitWithDefaults = explicitModels.map((m) =>
      applyInputDefaultForExplicitOnlyEntry(m, { builtInProvider }),
    );
    return {
      ...implicit,
      ...explicit,
      ...(explicitWithDefaults.length > 0 ? { models: explicitWithDefaults } : {}),
      ...(implicitHeaders || explicitHeaders
        ? {
            headers: {
              ...implicitHeaders,
              ...explicitHeaders,
            },
          }
        : {}),
    };
  }

  const implicitById = new Map(
    implicitModels
      .map((model) => [getProviderModelId(model), model] as const)
      .filter(([id]) => Boolean(id)),
  );
  const seen = new Set<string>();

  const mergedModels = explicitModels.map((explicitModel) => {
    const id = getProviderModelId(explicitModel);
    if (!id) {
      return explicitModel;
    }
    seen.add(id);
    const implicitModel = implicitById.get(id);
    if (!implicitModel) {
      return applyInputDefaultForExplicitOnlyEntry(explicitModel, { builtInProvider });
    }

    const contextWindow = resolvePreferredTokenLimit({
      explicitPresent: "contextWindow" in explicitModel,
      explicitValue: explicitModel.contextWindow,
      implicitValue: implicitModel.contextWindow,
    });
    const contextTokens = resolvePreferredTokenLimit({
      explicitPresent: "contextTokens" in explicitModel,
      explicitValue: explicitModel.contextTokens,
      implicitValue: implicitModel.contextTokens,
    });
    const maxTokens = resolvePreferredTokenLimit({
      explicitPresent: "maxTokens" in explicitModel,
      explicitValue: explicitModel.maxTokens,
      implicitValue: implicitModel.maxTokens,
    });

    return Object.assign(
      {},
      explicitModel,
      {
        input: "input" in explicitModel ? explicitModel.input : implicitModel.input,
        reasoning: `reasoning` in explicitModel ? explicitModel.reasoning : implicitModel.reasoning,
      },
      contextWindow === undefined ? {} : { contextWindow },
      contextTokens === undefined ? {} : { contextTokens },
      maxTokens === undefined ? {} : { maxTokens },
    );
  });

  for (const implicitModel of implicitModels) {
    const id = getProviderModelId(implicitModel);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    mergedModels.push(implicitModel);
  }

  return {
    ...implicit,
    ...explicit,
    ...(implicitHeaders || explicitHeaders
      ? {
          headers: {
            ...implicitHeaders,
            ...explicitHeaders,
          },
        }
      : {}),
    models: mergedModels,
  };
}

export function mergeProviders(params: {
  implicit?: Record<string, ProviderConfig> | null;
  explicit?: Record<string, ProviderConfig> | null;
}): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = params.implicit ? { ...params.implicit } : {};
  for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
    const providerKey = normalizeOptionalString(key) ?? "";
    if (!providerKey) {
      continue;
    }
    const implicit = out[providerKey];
    out[providerKey] = mergeProviderModels(
      implicit ?? ({ models: [] } as unknown as ProviderConfig),
      explicit,
      { providerKey },
    );
  }
  return out;
}

function resolveProviderApi(entry: { api?: unknown } | undefined): string | undefined {
  return normalizeOptionalString(entry?.api);
}

function resolveModelApiSurface(entry: { models?: unknown } | undefined): string | undefined {
  if (!Array.isArray(entry?.models)) {
    return undefined;
  }

  const apis = entry.models
    .flatMap((model) => {
      if (!model || typeof model !== "object") {
        return [];
      }
      const api = (model as { api?: unknown }).api;
      const normalized = normalizeOptionalString(api);
      return normalized ? [normalized] : [];
    })
    .toSorted();

  return apis.length > 0 ? JSON.stringify(apis) : undefined;
}

function resolveProviderApiSurface(
  entry: ExistingProviderConfig | ProviderConfig | undefined,
): string | undefined {
  return resolveProviderApi(entry) ?? resolveModelApiSurface(entry);
}

function shouldPreserveExistingApiKey(params: {
  providerKey: string;
  existing: ExistingProviderConfig;
  nextEntry: ProviderConfig;
  secretRefManagedProviders: ReadonlySet<string>;
}): boolean {
  const { providerKey, existing, nextEntry, secretRefManagedProviders } = params;
  const nextApiKey = typeof nextEntry.apiKey === "string" ? nextEntry.apiKey : "";
  if (nextApiKey && isNonSecretApiKeyMarker(nextApiKey)) {
    return false;
  }
  return (
    !secretRefManagedProviders.has(providerKey) &&
    typeof existing.apiKey === "string" &&
    existing.apiKey.length > 0 &&
    !isNonSecretApiKeyMarker(existing.apiKey, { includeEnvVarName: false })
  );
}

function shouldPreserveExistingBaseUrl(params: {
  existing: ExistingProviderConfig;
  nextEntry: ProviderConfig;
}): boolean {
  const { existing, nextEntry } = params;
  if (typeof existing.baseUrl !== "string" || existing.baseUrl.length === 0) {
    return false;
  }

  const existingApi = resolveProviderApiSurface(existing);
  const nextApi = resolveProviderApiSurface(nextEntry);
  return !existingApi || !nextApi || existingApi === nextApi;
}

function isExistingProviderSelfContained(entry: ExistingProviderConfig): boolean {
  if (!Array.isArray(entry.models) || entry.models.length === 0) {
    return true;
  }
  return Boolean(entry.baseUrl?.trim() && entry.apiKey);
}

export function mergeWithExistingProviderSecrets(params: {
  nextProviders: Record<string, ProviderConfig>;
  existingProviders: Record<string, ExistingProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
}): Record<string, ProviderConfig> {
  const { nextProviders, existingProviders, secretRefManagedProviders } = params;
  const mergedProviders: Record<string, ProviderConfig> = {};
  for (const [key, entry] of Object.entries(existingProviders)) {
    if (!isExistingProviderSelfContained(entry)) {
      continue;
    }
    mergedProviders[key] = entry;
  }
  for (const [key, newEntry] of Object.entries(nextProviders)) {
    const existing = existingProviders[key];
    if (!existing) {
      mergedProviders[key] = newEntry;
      continue;
    }
    const preserved: Record<string, unknown> = {};
    if (
      shouldPreserveExistingApiKey({
        providerKey: key,
        existing,
        nextEntry: newEntry,
        secretRefManagedProviders,
      })
    ) {
      preserved.apiKey = existing.apiKey;
    }
    if (
      shouldPreserveExistingBaseUrl({
        existing,
        nextEntry: newEntry,
      })
    ) {
      preserved.baseUrl = existing.baseUrl;
    }
    mergedProviders[key] = { ...newEntry, ...preserved };
  }
  return mergedProviders;
}
