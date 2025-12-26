import type { ClawdisConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";

export type ModelRef = {
  provider: string;
  model: string;
};

export type ModelAliasIndex = {
  byAlias: Map<string, { alias: string; ref: ModelRef }>;
  byKey: Map<string, string[]>;
};

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase();
}

export function modelKey(provider: string, model: string) {
  return `${provider}/${model}`;
}

export function parseModelRef(
  raw: string,
  defaultProvider: string,
): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return { provider: defaultProvider, model: trimmed };
  }
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

export function buildModelAliasIndex(params: {
  cfg: ClawdisConfig;
  defaultProvider: string;
}): ModelAliasIndex {
  const rawAliases = params.cfg.agent?.modelAliases ?? {};
  const byAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byKey = new Map<string, string[]>();

  for (const [aliasRaw, targetRaw] of Object.entries(rawAliases)) {
    const alias = aliasRaw.trim();
    if (!alias) continue;
    const parsed = parseModelRef(String(targetRaw ?? ""), params.defaultProvider);
    if (!parsed) continue;
    const aliasKey = normalizeAliasKey(alias);
    byAlias.set(aliasKey, { alias, ref: parsed });
    const key = modelKey(parsed.provider, parsed.model);
    const existing = byKey.get(key) ?? [];
    existing.push(alias);
    byKey.set(key, existing);
  }

  return { byAlias, byKey };
}

export function resolveModelRefFromString(params: {
  raw: string;
  defaultProvider: string;
  aliasIndex?: ModelAliasIndex;
}): { ref: ModelRef; alias?: string } | null {
  const trimmed = params.raw.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("/")) {
    const aliasKey = normalizeAliasKey(trimmed);
    const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
    if (aliasMatch) {
      return { ref: aliasMatch.ref, alias: aliasMatch.alias };
    }
  }
  const parsed = parseModelRef(trimmed, params.defaultProvider);
  if (!parsed) return null;
  return { ref: parsed };
}

export function resolveConfiguredModelRef(params: {
  cfg: ClawdisConfig;
  defaultProvider: string;
  defaultModel: string;
}): ModelRef {
  const rawModel = params.cfg.agent?.model?.trim() || "";
  if (rawModel) {
    const trimmed = rawModel.trim();
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: params.defaultProvider,
    });
    const resolved = resolveModelRefFromString({
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (resolved) return resolved.ref;
    // TODO(steipete): drop this fallback once provider-less agent.model is fully deprecated.
    return { provider: "anthropic", model: trimmed };
  }
  return { provider: params.defaultProvider, model: params.defaultModel };
}

export function buildAllowedModelSet(params: {
  cfg: ClawdisConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
}): {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
} {
  const rawAllowlist = params.cfg.agent?.allowedModels ?? [];
  const allowAny = rawAllowlist.length === 0;
  const catalogKeys = new Set(
    params.catalog.map((entry) => modelKey(entry.provider, entry.id)),
  );

  if (allowAny) {
    return {
      allowAny: true,
      allowedCatalog: params.catalog,
      allowedKeys: catalogKeys,
    };
  }

  const allowedKeys = new Set<string>();
  for (const raw of rawAllowlist) {
    const parsed = parseModelRef(String(raw), params.defaultProvider);
    if (!parsed) continue;
    const key = modelKey(parsed.provider, parsed.model);
    if (catalogKeys.has(key)) {
      allowedKeys.add(key);
    }
  }

  const allowedCatalog = params.catalog.filter((entry) =>
    allowedKeys.has(modelKey(entry.provider, entry.id)),
  );

  if (allowedCatalog.length === 0) {
    return {
      allowAny: true,
      allowedCatalog: params.catalog,
      allowedKeys: catalogKeys,
    };
  }

  return { allowAny: false, allowedCatalog, allowedKeys };
}
