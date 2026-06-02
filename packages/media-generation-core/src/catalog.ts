import { uniqueTrimmedStrings } from "./string.js";

export type MediaGenerationCatalogKind =
  | "image_generation"
  | "video_generation"
  | "music_generation";

export type MediaGenerationCatalogSource = "static" | "live" | "cache" | "configured";

export type MediaGenerationCatalogEntry<TCapabilities = unknown> = {
  /** Capability family the row belongs to, such as image or video generation. */
  kind: MediaGenerationCatalogKind;
  /** Provider id that owns the model. */
  provider: string;
  /** Provider model id. */
  model: string;
  label?: string;
  /** Origin of this catalog row: static metadata, live fetch, cache, or user config. */
  source: MediaGenerationCatalogSource;
  default?: boolean;
  configured?: boolean;
  capabilities?: TCapabilities;
  modes?: readonly string[];
  authEnvVars?: readonly string[];
  docsPath?: string;
  fetchedAt?: number;
  expiresAt?: number;
  warnings?: readonly string[];
};

export type MediaGenerationCatalogProvider<TCapabilities = unknown> = {
  id: string;
  aliases?: readonly string[];
  label?: string;
  defaultModel?: string;
  models?: readonly string[];
  capabilities: TCapabilities;
};

function uniqueModels(provider: { defaultModel?: string; models?: readonly string[] }): string[] {
  return uniqueTrimmedStrings([provider.defaultModel, ...(provider.models ?? [])]);
}

/** Builds stable static catalog rows from a provider default model plus advertised models. */
export function synthesizeMediaGenerationCatalogEntries<TCapabilities>(params: {
  kind: MediaGenerationCatalogKind;
  provider: MediaGenerationCatalogProvider<TCapabilities>;
  modes?: readonly string[];
}): Array<MediaGenerationCatalogEntry<TCapabilities>> {
  return uniqueModels(params.provider).map((model) => {
    const entry: MediaGenerationCatalogEntry<TCapabilities> = {
      kind: params.kind,
      provider: params.provider.id,
      model,
      source: "static",
      capabilities: params.provider.capabilities,
    };
    if (params.provider.label) {
      entry.label = params.provider.label;
    }
    if (model === params.provider.defaultModel) {
      entry.default = true;
    }
    if (params.modes) {
      entry.modes = params.modes;
    }
    return entry;
  });
}

/** Lists unique provider models in display order, with the default model first when present. */
export function listMediaGenerationProviderModels(provider: {
  defaultModel?: string;
  models?: readonly string[];
}): string[] {
  return uniqueModels(provider);
}
