// Google config-compat module repairs legacy provider blocks for the doctor
// contract. Older `openclaw` setup wrote `models.providers.google` /
// `google-vertex` blocks that the current model-catalog schema rejects: no
// `api`, `input` modalities beyond text/image, and a `cost` object without
// `cacheWrite`. Such a block passes config parsing but fails at catalog load,
// silently dropping the whole provider — every google model becomes
// unavailable and any fallback chain that selects one hangs on the 120s idle
// watchdog. This runs under `openclaw doctor` / `--fix`. See
// openclaw/openclaw#102138.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

const SUPPORTED_INPUT_MODALITIES = new Set(["text", "image"]);
const PROVIDER_API_BY_ID: Record<string, string> = {
  google: "google-generative-ai",
  "google-vertex": "google-vertex",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveProviderApi(providerId: string): string | undefined {
  return PROVIDER_API_BY_ID[providerId.trim().toLowerCase()];
}

function modelInputNeedsNarrowing(model: unknown): boolean {
  const record = asRecord(model);
  return Boolean(
    record &&
    Array.isArray(record.input) &&
    record.input.some((entry) => !SUPPORTED_INPUT_MODALITIES.has(entry as string)),
  );
}

function modelCostNeedsCacheWrite(model: unknown): boolean {
  const record = asRecord(model);
  const cost = asRecord(record?.cost);
  return Boolean(cost && cost.cacheWrite === undefined);
}

// A provider needs an api backfill when it has no provider-level api and at
// least one model also lacks its own api — otherwise that model fails catalog
// validation with `no "api" specified`. This is the condition the apply path
// acts on, so detection and repair stay symmetric (idempotent).
function providerNeedsApiBackfill(
  providerRecord: Record<string, unknown>,
  models: unknown[],
): boolean {
  if (providerRecord.api !== undefined) {
    return false;
  }
  return models.some((model) => asRecord(model)?.api === undefined);
}

function providerBlockNeedsRepair(providerId: string, provider: unknown): boolean {
  if (!resolveProviderApi(providerId)) {
    return false;
  }
  const providerRecord = asRecord(provider);
  const models = providerRecord?.models;
  if (!providerRecord || !Array.isArray(models) || models.length === 0) {
    return false;
  }
  if (providerNeedsApiBackfill(providerRecord, models)) {
    return true;
  }
  return models.some((model) => modelInputNeedsNarrowing(model) || modelCostNeedsCacheWrite(model));
}

function hasLegacyGoogleProviderBlock(providers: unknown): boolean {
  const providersRecord = asRecord(providers);
  if (!providersRecord) {
    return false;
  }
  return Object.entries(providersRecord).some(([providerId, provider]) =>
    providerBlockNeedsRepair(providerId, provider),
  );
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["models", "providers"],
    message:
      'A legacy google provider block in models.providers is missing catalog fields (api, input, cost.cacheWrite); run "openclaw doctor --fix" to repair it.',
    match: (value) => hasLegacyGoogleProviderBlock(value),
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const providers = asRecord(asRecord(cfg.models)?.providers);
  if (!providers || !hasLegacyGoogleProviderBlock(providers)) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg);
  const nextProviders = asRecord(asRecord(nextConfig.models)?.providers);
  if (!nextProviders) {
    return { config: cfg, changes: [] };
  }
  const changes: string[] = [];

  for (const [providerId, provider] of Object.entries(nextProviders)) {
    const api = resolveProviderApi(providerId);
    if (!api) {
      continue;
    }
    const providerRecord = asRecord(provider);
    const models = providerRecord?.models;
    if (!providerRecord || !Array.isArray(models) || models.length === 0) {
      continue;
    }

    for (const [index, model] of models.entries()) {
      const modelRecord = asRecord(model);
      if (!modelRecord) {
        continue;
      }

      if (Array.isArray(modelRecord.input)) {
        const narrowed = modelRecord.input.filter((entry) =>
          SUPPORTED_INPUT_MODALITIES.has(entry as string),
        );
        if (narrowed.length !== modelRecord.input.length) {
          modelRecord.input = narrowed;
          changes.push(
            `Narrowed models.providers.${providerId}.models[${index}].input to ${JSON.stringify(narrowed)} (dropped unsupported modalities).`,
          );
        }
      }

      const cost = asRecord(modelRecord.cost);
      if (cost && cost.cacheWrite === undefined) {
        cost.cacheWrite = 0;
        changes.push(
          `Set models.providers.${providerId}.models[${index}].cost.cacheWrite to 0 (required by catalog schema).`,
        );
      }
    }

    if (providerNeedsApiBackfill(providerRecord, models)) {
      providerRecord.api = api;
      changes.push(
        `Set models.providers.${providerId}.api to "${api}" (required by catalog schema).`,
      );
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: nextConfig, changes };
}
