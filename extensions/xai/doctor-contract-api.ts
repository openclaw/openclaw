import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  isLegacyXaiBuiltinModel,
  resolveXaiCatalogEntry,
  XAI_BASE_URL,
  XAI_GROK_OAUTH_BASE_URL,
} from "./model-definitions.js";
import { isXaiProviderId } from "./provider-id.js";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

type PluginModelMigration = {
  key: string;
  retiredModels: ReadonlySet<string>;
  targetModel: string;
};

const RETIRED_REASONING_MODELS = new Set([
  "grok-4-1-fast",
  "grok-4-1-fast-reasoning",
  "grok-4-fast",
  "grok-4-fast-reasoning",
  "grok-4-0709",
]);
const RETIRED_NON_REASONING_MODELS = new Set([
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-3",
]);
const RETIRED_CODE_MODELS = new Set([
  "grok-code-fast-1",
  "grok-code-fast",
  "grok-code-fast-1-0825",
]);

const PLUGIN_MODEL_MIGRATIONS: PluginModelMigration[] = [
  {
    key: "webSearch",
    retiredModels: RETIRED_REASONING_MODELS,
    targetModel: "grok-4.3",
  },
  {
    key: "codeExecution",
    retiredModels: RETIRED_REASONING_MODELS,
    targetModel: "grok-4.3",
  },
  {
    key: "xSearch",
    retiredModels: RETIRED_NON_REASONING_MODELS,
    targetModel: "grok-4.3",
  },
  ...["webSearch", "codeExecution", "xSearch"].map((key) => ({
    key,
    retiredModels: RETIRED_CODE_MODELS,
    targetModel: "grok-build-0.1",
  })),
];
const XAI_MEDIA_MODEL_LIST_PATHS = [["tools", "media", "models"]] as const;

function isRetiredToolModel(value: unknown, retiredModels: ReadonlySet<string>): boolean {
  const model = asObjectRecord(value)?.model;
  return typeof model === "string" && retiredModels.has(model.trim().toLowerCase());
}

function hasLegacyBuiltinCatalogRows(value: unknown): boolean {
  return Array.isArray(value) && value.some((model) => isLegacyXaiBuiltinModel(model));
}

const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
const XAI_OFFICIAL_BASE_URLS = new Set(
  [XAI_BASE_URL, XAI_GROK_OAUTH_BASE_URL].map(normalizeBaseUrl),
);

// OAuth sign-in saved each catalog row's flat cost before the catalog carried xAI's
// long-context tier, and saved rows override the catalog. Only rows on an official xAI
// route that still carry the catalog's flat rates get the tier. A custom baseUrl owns its
// own billing, and custom prices or existing tiers stay as written.
function catalogPricingTiersFor(model: unknown, providerBaseUrl: unknown) {
  const record = asObjectRecord(model);
  const cost = asObjectRecord(record?.cost);
  const route =
    typeof record?.baseUrl === "string" && record.baseUrl.trim() ? record.baseUrl : providerBaseUrl;
  const catalog =
    typeof record?.id === "string" ? resolveXaiCatalogEntry(record.id)?.cost : undefined;
  if (
    !cost ||
    (typeof route === "string" &&
      route.trim() &&
      !XAI_OFFICIAL_BASE_URLS.has(normalizeBaseUrl(route))) ||
    cost.tieredPricing !== undefined ||
    !catalog?.tieredPricing?.length ||
    cost.input !== catalog.input ||
    cost.output !== catalog.output ||
    cost.cacheRead !== catalog.cacheRead ||
    cost.cacheWrite !== catalog.cacheWrite
  ) {
    return undefined;
  }
  return catalog.tieredPricing;
}

function hasUntieredCatalogPricedRows(value: unknown): boolean {
  const provider = asObjectRecord(value);
  return (
    Array.isArray(provider?.models) &&
    provider.models.some((model) => catalogPricingTiersFor(model, provider.baseUrl))
  );
}

function asXaiProviderMediaEntry(value: unknown) {
  const entry = asObjectRecord(value);
  // An omitted type plus a command is a CLI entry at runtime. Its model is an arbitrary label.
  if (
    !entry ||
    (entry.type !== undefined && entry.type !== "provider") ||
    (entry.type === undefined && entry.command)
  ) {
    return undefined;
  }
  if (!isXaiProviderId(entry.provider)) {
    return undefined;
  }
  return entry;
}

function hasImageCapability(entry: { capabilities?: unknown }): boolean {
  return (
    Array.isArray(entry.capabilities) &&
    entry.capabilities.some(
      (capability) => typeof capability === "string" && capability.trim().toLowerCase() === "image",
    )
  );
}

function isRetiredXaiImageMediaEntry(value: unknown): boolean {
  const entry = asXaiProviderMediaEntry(value);
  // Media entries cannot preserve "reasoning disabled", so migrate only compatible redirects.
  // Shared xAI media entries without capabilities infer audio from provider
  // metadata, so rewriting them to grok-4.3 would mutate audio config.
  // Require an explicit capabilities tag that includes image.
  return (
    typeof entry?.model === "string" &&
    RETIRED_REASONING_MODELS.has(entry.model.trim().toLowerCase()) &&
    hasImageCapability(entry)
  );
}

function hasRetiredXaiImageMediaEntries(value: unknown): boolean {
  return Array.isArray(value) && value.some(isRetiredXaiImageMediaEntry);
}

function isLegacyXaiSttEntry(value: unknown): boolean {
  const entry = asXaiProviderMediaEntry(value);
  return typeof entry?.model === "string" && entry.model.trim().toLowerCase() === "grok-stt";
}

function hasLegacyXaiSttEntries(value: unknown): boolean {
  return Array.isArray(value) && value.some(isLegacyXaiSttEntry);
}

export const legacyConfigRules: LegacyConfigRule[] = [
  ...PLUGIN_MODEL_MIGRATIONS.map((migration) => ({
    path: ["plugins", "entries", "xai", "config", migration.key],
    message: `plugins.entries.xai.config.${migration.key}.model uses a retired xAI model; run "openclaw doctor --fix" to use ${migration.targetModel}.`,
    match: (value: unknown) => isRetiredToolModel(value, migration.retiredModels),
  })),
  ...XAI_MEDIA_MODEL_LIST_PATHS.map((path) => ({
    path: [...path],
    message: `${path.join(".")} contains an xAI image entry with a retired model; run "openclaw doctor --fix" to migrate it to grok-4.3.`,
    match: hasRetiredXaiImageMediaEntries,
  })),
  ...XAI_MEDIA_MODEL_LIST_PATHS.map((path) => ({
    path: [...path],
    message: `${path.join(".")} contains the obsolete xAI grok-stt model selector; run "openclaw doctor --fix" to remove it.`,
    match: hasLegacyXaiSttEntries,
  })),
  {
    path: ["models", "providers", "xai", "models"],
    message:
      'models.providers.xai.models contains stale generated xAI catalog rows; run "openclaw doctor --fix" to remove them.',
    match: hasLegacyBuiltinCatalogRows,
  },
  {
    path: ["models", "providers", "xai"],
    message:
      'models.providers.xai.models has saved xAI rows without the catalog\'s long-context price tier; run "openclaw doctor --fix" to add it.',
    match: hasUntieredCatalogPricedRows,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  let next = cfg;
  const changes: string[] = [];

  const pluginConfig = asObjectRecord(cfg.plugins?.entries?.xai?.config);
  const migratedPluginConfig = { ...pluginConfig };
  for (const migration of PLUGIN_MODEL_MIGRATIONS) {
    const current = asObjectRecord(migratedPluginConfig[migration.key]);
    if (!isRetiredToolModel(current, migration.retiredModels)) {
      continue;
    }
    migratedPluginConfig[migration.key] = { ...current, model: migration.targetModel };
    changes.push(
      `Updated plugins.entries.xai.config.${migration.key}.model from ${JSON.stringify(current?.model)} to ${JSON.stringify(migration.targetModel)}.`,
    );
  }
  if (changes.length > 0) {
    next = {
      ...next,
      plugins: {
        ...cfg.plugins,
        entries: {
          ...cfg.plugins?.entries,
          xai: { ...cfg.plugins?.entries?.xai, config: migratedPluginConfig },
        },
      },
    };
  }

  for (const path of XAI_MEDIA_MODEL_LIST_PATHS) {
    const entries = cfg.tools?.media?.models;
    if (!Array.isArray(entries)) {
      continue;
    }
    let migrated = 0;
    let removed = 0;
    const models: typeof entries = [];
    for (const entry of entries) {
      if (isRetiredXaiImageMediaEntry(entry)) {
        migrated += 1;
        models.push({ ...entry, model: "grok-4.3" });
      } else if (isLegacyXaiSttEntry(entry)) {
        const { model: _model, ...retained } = entry;
        removed += 1;
        models.push(retained);
      } else {
        models.push(entry);
      }
    }
    if (migrated > 0 || removed > 0) {
      next = {
        ...next,
        tools: { ...next.tools, media: { ...next.tools?.media, models } },
      };
    }
    if (migrated > 0) {
      changes.push(
        `Migrated ${migrated} retired xAI image model${migrated === 1 ? "" : "s"} in ${path.join(".")} to grok-4.3.`,
      );
    }
    if (removed > 0) {
      changes.push(
        `Removed the obsolete xAI grok-stt model selector from ${removed} ${path.join(".")} entr${removed === 1 ? "y" : "ies"}.`,
      );
    }
  }

  const provider = cfg.models?.providers?.xai;
  if (provider && Array.isArray(provider.models)) {
    const retained = provider.models.filter((model) => !isLegacyXaiBuiltinModel(model));
    const removed = provider.models.length - retained.length;
    if (removed > 0) {
      next = {
        ...next,
        models: {
          ...next.models,
          providers: { ...next.models?.providers, xai: { ...provider, models: retained } },
        },
      };
      changes.push(`Removed ${removed} stale generated xAI model catalog row(s).`);
    }
  }

  const savedProvider = next.models?.providers?.xai;
  if (savedProvider && Array.isArray(savedProvider.models)) {
    let tiered = 0;
    const models = savedProvider.models.map((model) => {
      const tiers = catalogPricingTiersFor(model, savedProvider.baseUrl);
      if (!tiers) {
        return model;
      }
      tiered += 1;
      // Config takes its own copy; later config edits must not reach the shared catalog.
      return { ...model, cost: { ...model.cost, tieredPricing: structuredClone(tiers) } };
    });
    if (tiered > 0) {
      next = {
        ...next,
        models: {
          ...next.models,
          providers: { ...next.models?.providers, xai: { ...savedProvider, models } },
        },
      };
      changes.push(`Added xAI's long-context price tier to ${tiered} saved xAI model row(s).`);
    }
  }

  return { config: next, changes };
}
