// Google config compatibility repairs for legacy provider catalog rows.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isGoogleVertexBaseUrl } from "./src/google-api-base-url.js";

type JsonRecord = Record<string, unknown>;
type GoogleProviderId = "google" | "google-vertex";

const PROVIDER_API_BY_ID: Record<GoogleProviderId, string> = {
  google: "google-generative-ai",
  "google-vertex": "google-vertex",
};
const PROVIDER_PATH_BY_ID: Record<GoogleProviderId, string> = {
  google: "models.providers.google",
  "google-vertex": "models.providers.google-vertex",
};
const CATALOG_INPUT_VALUES = new Set(["text", "image"]);
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function shouldRepairProvider(providerId: GoogleProviderId, provider: JsonRecord): boolean {
  const expectedApi = PROVIDER_API_BY_ID[providerId];
  const api = normalizeOptionalString(provider.api);
  if (api !== undefined && api !== expectedApi) {
    return false;
  }
  if (providerId === "google-vertex" && api === undefined) {
    return !provider.baseUrl || isGoogleVertexBaseUrl(normalizeOptionalString(provider.baseUrl));
  }
  return true;
}

function normalizeCatalogInput(input: unknown): { input: string[]; changed: boolean } | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const next: string[] = [];
  let changed = false;
  for (const value of input) {
    if (typeof value === "string" && CATALOG_INPUT_VALUES.has(value)) {
      if (!next.includes(value)) {
        next.push(value);
      } else {
        changed = true;
      }
      continue;
    }
    changed = true;
  }

  if (!changed) {
    return undefined;
  }
  return { input: next.length > 0 ? next : ["text"], changed: true };
}

function normalizeCatalogCost(cost: unknown): { cost: JsonRecord; changed: boolean } | undefined {
  if (!isRecord(cost)) {
    return undefined;
  }

  let next: JsonRecord | undefined;
  for (const field of COST_FIELDS) {
    const value = cost[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      continue;
    }
    next ??= { ...cost };
    next[field] = 0;
  }

  return next ? { cost: next, changed: true } : undefined;
}

function normalizeProviderModels(provider: JsonRecord): {
  models: unknown[];
  changed: boolean;
} {
  if (!Array.isArray(provider.models)) {
    return { models: [], changed: false };
  }

  let changed = false;
  const models = provider.models.map((model) => {
    if (!isRecord(model)) {
      return model;
    }

    let nextModel: JsonRecord | undefined;
    const input = normalizeCatalogInput(model.input);
    if (input?.changed) {
      nextModel ??= { ...model };
      nextModel.input = input.input;
    }

    const cost = normalizeCatalogCost(model.cost);
    if (cost?.changed) {
      nextModel ??= { ...model };
      nextModel.cost = cost.cost;
    }

    if (nextModel) {
      changed = true;
      return nextModel;
    }
    return model;
  });

  return { models, changed };
}

function migrateProvider(
  providerId: GoogleProviderId,
  provider: unknown,
): { provider: JsonRecord; changed: boolean } | undefined {
  if (!isRecord(provider) || !shouldRepairProvider(providerId, provider)) {
    return undefined;
  }

  const expectedApi = PROVIDER_API_BY_ID[providerId];
  let nextProvider: JsonRecord | undefined;
  if (!normalizeOptionalString(provider.api)) {
    nextProvider = { ...provider, api: expectedApi };
  }

  const models = normalizeProviderModels(provider);
  if (models.changed) {
    nextProvider ??= { ...provider };
    nextProvider.models = models.models;
  }

  return nextProvider ? { provider: nextProvider, changed: true } : undefined;
}

/** Migrate legacy Google provider blocks to the current model-catalog schema. */
export function migrateGoogleLegacyProviderConfig(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const providers = cfg.models?.providers;
  if (!providers) {
    return { config: cfg, changes: [] };
  }

  let nextProviders: typeof providers | undefined;
  const changes: string[] = [];
  for (const providerId of Object.keys(PROVIDER_API_BY_ID) as GoogleProviderId[]) {
    const migrated = migrateProvider(providerId, providers[providerId]);
    if (!migrated?.changed) {
      continue;
    }
    nextProviders ??= { ...providers };
    nextProviders[providerId] = migrated.provider as (typeof providers)[typeof providerId];
    changes.push(`Updated legacy Google provider config at ${PROVIDER_PATH_BY_ID[providerId]}.`);
  }

  if (!nextProviders) {
    return { config: cfg, changes: [] };
  }

  return {
    config: {
      ...cfg,
      models: {
        ...cfg.models,
        providers: nextProviders,
      },
    },
    changes,
  };
}
