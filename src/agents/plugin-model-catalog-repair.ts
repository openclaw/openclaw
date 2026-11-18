/** Pure repair rules for OpenClaw-generated plugin model catalogs. */
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeModelCostForCatalog } from "./model-cost-normalization.js";

export const PLUGIN_MODEL_CATALOG_GENERATED_BY = "openclaw-plugin-model-catalog-v1";

type PluginModelCatalogRepair = {
  contents: string;
  inspectionIncomplete: boolean;
  removedModelCount: number;
  completedCostModelCount: number;
};

function hasCatalogApi(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/** Detects the existing generated-catalog marker without admitting arrays or null. */
export function isGeneratedPluginModelCatalog(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.generatedBy === PLUGIN_MODEL_CATALOG_GENERATED_BY;
}

/** Removes unusable transport rows and completes numeric partial costs with the writer's rule. */
export function repairPluginModelCatalogTransportMetadata(
  contents: string,
): PluginModelCatalogRepair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return {
      contents,
      inspectionIncomplete: true,
      removedModelCount: 0,
      completedCostModelCount: 0,
    };
  }
  if (!isGeneratedPluginModelCatalog(parsed) || !isRecord(parsed.providers)) {
    return {
      contents,
      inspectionIncomplete: true,
      removedModelCount: 0,
      completedCostModelCount: 0,
    };
  }

  let removedModelCount = 0;
  let inspectionIncomplete = false;
  let completedCostModelCount = 0;
  const providers: Record<string, unknown> = {};
  for (const [providerId, provider] of Object.entries(parsed.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) {
      inspectionIncomplete = true;
      providers[providerId] = provider;
      continue;
    }
    // A provider-level API covers rows that do not declare their own; only an
    // undeclared transport API is unrepairable, and that shape is dropped.
    const providerApi = hasCatalogApi(provider.api);
    const models: unknown[] = [];
    let providerChanged = false;
    for (const model of provider.models) {
      const modelRecord = asOptionalRecord(model);
      inspectionIncomplete ||= !modelRecord;
      if (!providerApi && (!modelRecord || !hasCatalogApi(modelRecord.api))) {
        removedModelCount += 1;
        providerChanged = true;
        continue;
      }
      const completed = modelRecord ? normalizeModelCostForCatalog(modelRecord) : model;
      if (completed !== model) {
        completedCostModelCount += 1;
        providerChanged = true;
      }
      models.push(completed);
    }
    providers[providerId] = providerChanged ? { ...provider, models } : provider;
  }
  if (removedModelCount === 0 && completedCostModelCount === 0) {
    return { contents, inspectionIncomplete, removedModelCount, completedCostModelCount };
  }
  const trailingNewline = contents.endsWith("\n") ? "\n" : "";
  return {
    contents: `${JSON.stringify({ ...parsed, providers }, null, 2)}${trailingNewline}`,
    inspectionIncomplete,
    removedModelCount,
    completedCostModelCount,
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
