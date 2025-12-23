import type { ClawdisConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";

export type ModelRef = {
  provider: string;
  model: string;
};

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
