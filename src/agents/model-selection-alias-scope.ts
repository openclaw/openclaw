import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ManifestModelIdNormalizationSource } from "../plugins/manifest-model-id-normalization.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import type { ModelRef } from "./model-ref-shared.js";

export type EffectiveModelAlias = {
  keyRaw: string;
  alias: string;
  ref: ModelRef;
  qualifiedOnly: boolean;
};

export function providerAliasKey(provider: string, alias: string): string {
  return `${normalizeProviderId(provider)}/${normalizeLowercaseStringOrEmpty(alias)}`;
}

export function findModelAliasCandidate(
  candidates: readonly EffectiveModelAlias[],
  raw: string,
  provider?: string,
): EffectiveModelAlias | undefined {
  const aliasKey = normalizeLowercaseStringOrEmpty(raw);
  const scopedProvider = provider ? normalizeProviderId(provider) : undefined;
  return candidates.findLast(
    (candidate) =>
      (!candidate.qualifiedOnly || scopedProvider !== undefined) &&
      normalizeLowercaseStringOrEmpty(candidate.alias) === aliasKey &&
      (!scopedProvider || normalizeProviderId(candidate.ref.provider) === scopedProvider),
  );
}

export function preferLiteralPrimary(primary: string, aliasKey: string): boolean {
  const hasSlashRef = (raw: string) => {
    const trimmed = raw.trim();
    const slash = trimmed.indexOf("/");
    return slash > 0 && slash < trimmed.length - 1;
  };
  return hasSlashRef(primary) && !hasSlashRef(aliasKey);
}

/** Capture provider authority while preparing aliases, including config-free index consumers. */
export function createModelAliasScope(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  manifestPlugins: () => ManifestModelIdNormalizationSource | undefined;
}): (alias: string, ref: ModelRef) => boolean {
  const configuredProviders = new Set(
    [
      DEFAULT_PROVIDER,
      params.defaultProvider,
      ...Object.keys(params.cfg.models?.providers ?? {}),
    ].map(normalizeProviderId),
  );
  let declaredProviders: ReadonlySet<string> | undefined;
  return (alias, ref) => {
    const { model } = splitTrailingAuthProfile(alias);
    const slash = model.indexOf("/");
    if (slash <= 0) {
      return false;
    }
    const provider = normalizeProviderId(model.slice(0, slash));
    if (provider === normalizeProviderId(ref.provider)) {
      return false;
    }
    if (configuredProviders.has(provider)) {
      return true;
    }
    if (!declaredProviders) {
      const source = params.manifestPlugins();
      const providers = source
        ? "owners" in source
          ? [...(source.owners.providers?.keys() ?? [])]
          : source.flatMap((plugin) => plugin.providers ?? [])
        : [];
      declaredProviders = new Set(providers.map(normalizeProviderId));
    }
    return declaredProviders.has(provider);
  };
}
