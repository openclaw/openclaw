import type { OpenClawConfig } from "../config/config.js";
import type { ModelCompatConfig, ModelDefinitionConfig } from "../config/types.models.js";
import { normalizeProviderId } from "./provider-id.js";

export type ModelInputType = "text" | "image" | "document";

export type ModelMetadata = {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  cost?: ModelDefinitionConfig["cost"];
  compat?: ModelCompatConfig;
};

type ConfiguredProviders = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;
type ConfiguredProvider = ConfiguredProviders[string];
type ConfiguredModel = NonNullable<ConfiguredProvider["models"]>[number];

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

export function normalizeModelMetadataInput(input: unknown): ModelInputType[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is ModelInputType => item === "text" || item === "image" || item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeModelName(params: { id: string; name: unknown }): string {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  return name || params.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeModelCost(cost: unknown): ModelDefinitionConfig["cost"] | undefined {
  if (!isRecord(cost)) {
    return undefined;
  }
  const input = typeof cost.input === "number" ? cost.input : undefined;
  const output = typeof cost.output === "number" ? cost.output : undefined;
  const cacheRead = typeof cost.cacheRead === "number" ? cost.cacheRead : undefined;
  const cacheWrite = typeof cost.cacheWrite === "number" ? cost.cacheWrite : undefined;
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

function normalizeModelCompat(value: unknown): ModelCompatConfig | undefined {
  return isRecord(value) ? (value as ModelCompatConfig) : undefined;
}

export function buildModelMetadataLookupKey(provider: string, modelId: string): string {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedProvider || !normalizedModelId) {
    return "";
  }
  return normalizedModelId.startsWith(`${normalizedProvider}/`)
    ? normalizedModelId
    : `${normalizedProvider}/${normalizedModelId}`;
}

export function toConfiguredModelMetadata(params: {
  provider: string;
  model: ConfiguredModel | Record<string, unknown>;
}): ModelMetadata | null {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return null;
  }
  const idRaw = params.model?.id;
  const id = typeof idRaw === "string" ? idRaw.trim() : "";
  if (!id) {
    return null;
  }
  return {
    provider,
    id,
    name: normalizeModelName({ id, name: params.model?.name }),
    contextWindow: normalizePositiveInteger(params.model?.contextWindow),
    maxTokens: normalizePositiveInteger(params.model?.maxTokens),
    reasoning: typeof params.model?.reasoning === "boolean" ? params.model.reasoning : undefined,
    input: normalizeModelMetadataInput(params.model?.input),
    cost: normalizeModelCost(params.model?.cost),
    compat: normalizeModelCompat(params.model?.compat),
  };
}

export function listConfiguredModelMetadata(cfg: OpenClawConfig | undefined): ModelMetadata[] {
  const providers = cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const metadata: ModelMetadata[] = [];
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!Array.isArray(providerConfig?.models)) {
      continue;
    }
    for (const model of providerConfig.models) {
      const entry = toConfiguredModelMetadata({ provider: providerId, model });
      if (entry) {
        metadata.push(entry);
      }
    }
  }
  return metadata;
}

function findConfiguredModelInProviders(params: {
  providers: ConfiguredProviders;
  providerMatch: (providerId: string) => boolean;
  modelId: string;
}): ModelMetadata | undefined {
  for (const [providerId, providerConfig] of Object.entries(params.providers)) {
    if (!params.providerMatch(providerId) || !Array.isArray(providerConfig?.models)) {
      continue;
    }
    for (const model of providerConfig.models) {
      if (typeof model?.id !== "string" || model.id !== params.modelId) {
        continue;
      }
      const metadata = toConfiguredModelMetadata({ provider: providerId, model });
      if (metadata) {
        return metadata;
      }
    }
  }
  return undefined;
}

export function findConfiguredModelMetadata(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
}): ModelMetadata | undefined {
  const providers = params.cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }

  const providerRaw = params.provider.trim();
  const modelRaw = params.model.trim();
  if (!providerRaw || !modelRaw) {
    return undefined;
  }

  const exact = findConfiguredModelInProviders({
    providers,
    providerMatch: (providerId) => providerId.trim().toLowerCase() === providerRaw.toLowerCase(),
    modelId: modelRaw,
  });
  if (exact) {
    return exact;
  }

  const normalizedProvider = normalizeProviderId(providerRaw);
  return findConfiguredModelInProviders({
    providers,
    providerMatch: (providerId) => normalizeProviderId(providerId) === normalizedProvider,
    modelId: modelRaw,
  });
}

export function mergeModelMetadata(
  base: ModelMetadata,
  overlay: Partial<ModelMetadata>,
  options?: { overrideName?: boolean },
): ModelMetadata {
  const name = overlay.name?.trim();
  const input = normalizeModelMetadataInput(overlay.input);
  return {
    ...base,
    ...(options?.overrideName && name ? { name } : {}),
    ...(normalizePositiveInteger(overlay.contextWindow) === undefined
      ? {}
      : { contextWindow: normalizePositiveInteger(overlay.contextWindow) }),
    ...(normalizePositiveInteger(overlay.maxTokens) === undefined
      ? {}
      : { maxTokens: normalizePositiveInteger(overlay.maxTokens) }),
    ...(typeof overlay.reasoning === "boolean" ? { reasoning: overlay.reasoning } : {}),
    ...(input ? { input } : {}),
    ...(overlay.cost ? { cost: overlay.cost } : {}),
    ...(overlay.compat ? { compat: overlay.compat } : {}),
  };
}

export function findModelMetadataInCatalog<T extends Pick<ModelMetadata, "provider" | "id">>(
  catalog: T[],
  provider: string,
  modelId: string,
): T | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModelId = modelId.toLowerCase().trim();
  return catalog.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModelId,
  );
}

export function modelMetadataSupportsInput(
  entry: Pick<ModelMetadata, "input"> | undefined,
  inputType: ModelInputType,
): boolean {
  return entry?.input?.includes(inputType) ?? false;
}
