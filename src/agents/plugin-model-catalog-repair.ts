/** Pure repair rules for OpenClaw-generated plugin model catalogs. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const PLUGIN_MODEL_CATALOG_GENERATED_BY = "openclaw-plugin-model-catalog-v1";

type PluginModelCatalogRepair = {
  contents: string;
  removedModelCount: number;
};

function hasCatalogApi(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/** Detects the existing generated-catalog marker without admitting arrays or null. */
export function isGeneratedPluginModelCatalog(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.generatedBy === PLUGIN_MODEL_CATALOG_GENERATED_BY;
}

/** Removes model rows whose transport API cannot be derived without inventing semantics. */
export function repairPluginModelCatalogTransportMetadata(
  contents: string,
): PluginModelCatalogRepair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return { contents, removedModelCount: 0 };
  }
  if (!isGeneratedPluginModelCatalog(parsed) || !isRecord(parsed.providers)) {
    return { contents, removedModelCount: 0 };
  }

  let removedModelCount = 0;
  const providers: Record<string, unknown> = {};
  for (const [providerId, provider] of Object.entries(parsed.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models) || hasCatalogApi(provider.api)) {
      providers[providerId] = provider;
      continue;
    }
    const models = provider.models.filter((model) => isRecord(model) && hasCatalogApi(model.api));
    removedModelCount += provider.models.length - models.length;
    providers[providerId] =
      models.length === provider.models.length ? provider : { ...provider, models };
  }
  if (removedModelCount === 0) {
    return { contents, removedModelCount };
  }
  const trailingNewline = contents.endsWith("\n") ? "\n" : "";
  return {
    contents: `${JSON.stringify({ ...parsed, providers }, null, 2)}${trailingNewline}`,
    removedModelCount,
  };
}

/** Returns null for unusable generated rows, which must not retain or export unknown secrets. */
export function stripPluginModelCatalogCredentials(
  contents: string,
  credentials?: ReadonlySet<string>,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isGeneratedPluginModelCatalog(parsed) || !isRecord(parsed.providers)) {
    return null;
  }
  let changed = false;
  const matches = (value: unknown): boolean =>
    typeof value === "string" &&
    (credentials === undefined ||
      credentials.has(value) ||
      (value.startsWith("Bearer ") && credentials.has(value.slice(7))));
  const strip = (entry: Record<string, unknown>): boolean => {
    if (entry.apiKey !== undefined) {
      if (credentials !== undefined && typeof entry.apiKey !== "string") {
        return false;
      }
      if (credentials === undefined || matches(entry.apiKey)) {
        delete entry.apiKey;
        changed = true;
      }
    }
    if (entry.headers !== undefined) {
      if (credentials === undefined) {
        delete entry.headers;
        changed = true;
      } else {
        if (!isRecord(entry.headers)) {
          return false;
        }
        for (const [name, value] of Object.entries(entry.headers)) {
          if (typeof value !== "string") {
            return false;
          }
          if (matches(value)) {
            delete entry.headers[name];
            changed = true;
          }
        }
      }
    }
    return true;
  };
  for (const provider of Object.values(parsed.providers)) {
    if (!isRecord(provider) || !strip(provider)) {
      return null;
    }
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models)) {
        return null;
      }
      for (const model of provider.models) {
        if (!isRecord(model) || !strip(model)) {
          return null;
        }
      }
    }
  }
  return changed ? JSON.stringify(parsed) : contents;
}
