// Arcee doctor contract repairs the shipped OpenRouter onboarding shape. Older
// releases stored an OpenRouter catalog under `models.providers.arcee`, so the
// runtime could not use the accompanying `openrouter:default` credential.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";

const LEGACY_PROVIDER_PATH = "models.providers.arcee";
const CANONICAL_PROVIDER_PATH = "models.providers.openrouter";
const CANONICAL_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const MODEL_REF_MIGRATIONS = new Map([
  ["arcee/trinity-large-preview", "openrouter/arcee-ai/trinity-large-preview"],
  ["arcee/trinity-large-thinking", "openrouter/arcee-ai/trinity-large-thinking"],
]);

function isOpenRouterBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new URL(value).hostname.toLowerCase() === "openrouter.ai";
  } catch {
    return false;
  }
}

function isLegacyOpenRouterProvider(value: unknown): boolean {
  return isOpenRouterBaseUrl(asObjectRecord(value)?.baseUrl);
}

export const legacyConfigRules = [
  {
    path: ["models", "providers", "arcee"],
    message: `${LEGACY_PROVIDER_PATH} owns an OpenRouter catalog but cannot use OpenRouter credentials; run "openclaw doctor --fix" to move it to ${CANONICAL_PROVIDER_PATH}.`,
    match: isLegacyOpenRouterProvider,
  },
];

function mergeCatalogModels(current: unknown, legacy: unknown): unknown {
  if (!Array.isArray(current)) {
    return Array.isArray(legacy) ? legacy : current;
  }
  if (!Array.isArray(legacy)) {
    return current;
  }

  const seenIds = new Set(
    current
      .map((model) => asObjectRecord(model)?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const missingLegacyModels = legacy.filter((model) => {
    const id = asObjectRecord(model)?.id;
    return typeof id !== "string" || !seenIds.has(id);
  });
  return missingLegacyModels.length > 0 ? [...current, ...missingLegacyModels] : current;
}

function buildCanonicalOpenRouterProvider(params: {
  current: Record<string, unknown> | null | undefined;
  legacy: Record<string, unknown>;
}): Record<string, unknown> {
  if (!params.current) {
    return {
      ...params.legacy,
      baseUrl: CANONICAL_OPENROUTER_BASE_URL,
    };
  }
  return {
    ...params.current,
    models: mergeCatalogModels(params.current.models, params.legacy.models),
  };
}

function migrateModelRef(value: unknown): unknown {
  return typeof value === "string" ? (MODEL_REF_MIGRATIONS.get(value) ?? value) : value;
}

function migrateModelSelection(value: unknown): unknown {
  if (typeof value === "string") {
    return migrateModelRef(value);
  }
  const selection = asObjectRecord(value);
  if (!selection) {
    return value;
  }

  const primary = migrateModelRef(selection.primary);
  const fallbacks = Array.isArray(selection.fallbacks)
    ? selection.fallbacks.map(migrateModelRef)
    : selection.fallbacks;
  if (primary === selection.primary && fallbacks === selection.fallbacks) {
    return value;
  }
  return {
    ...selection,
    ...(primary !== undefined ? { primary } : {}),
    ...(fallbacks !== undefined ? { fallbacks } : {}),
  };
}

function migrateAgentModelMap(value: unknown): unknown {
  const models = asObjectRecord(value);
  if (!models) {
    return value;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [modelRef, modelConfig] of Object.entries(models)) {
    const canonicalRef = migrateModelRef(modelRef);
    if (typeof canonicalRef !== "string" || canonicalRef === modelRef) {
      if (!Object.hasOwn(next, modelRef)) {
        next[modelRef] = modelConfig;
      }
      continue;
    }
    const existing = asObjectRecord(next[canonicalRef] ?? models[canonicalRef]);
    const legacy = asObjectRecord(modelConfig);
    next[canonicalRef] =
      legacy && existing ? { ...legacy, ...existing } : (existing ?? modelConfig);
    changed = true;
  }
  return changed ? next : value;
}

// Match the model-selection scopes accepted at config mutation boundaries.
// Walk only these paths, not arbitrary strings in prompts or plugin settings.
const AGENT_MODEL_SELECTION_PATHS = [
  ["model"],
  ["imageModel"],
  ["voiceModel"],
  ["pdfModel"],
  ["utilityModel"],
  ["mediaModels", "image"],
  ["mediaModels", "video"],
  ["mediaModels", "music"],
  ["heartbeat", "model"],
  ["subagents", "model"],
  ["compaction", "model"],
  ["compaction", "memoryFlush", "model"],
] as const;

function migrateModelPath(
  value: unknown,
  path: readonly string[],
  migrate: (value: unknown) => unknown,
): unknown {
  const record = asObjectRecord(value);
  const [key, ...rest] = path;
  if (!record || !key || !Object.hasOwn(record, key)) {
    return value;
  }
  const next = rest.length ? migrateModelPath(record[key], rest, migrate) : migrate(record[key]);
  return next === record[key] ? value : { ...record, [key]: next };
}

function migrateAgentModelScope(value: unknown): unknown {
  let next = value;
  for (const path of AGENT_MODEL_SELECTION_PATHS) {
    next = migrateModelPath(next, path, migrateModelSelection);
  }
  next = migrateModelPath(next, ["models"], migrateAgentModelMap);
  return migrateModelPath(next, ["modelPolicy", "allow"], (allow) =>
    Array.isArray(allow) ? allow.map(migrateModelRef) : allow,
  );
}

function migrateAgentScopes(agents: Record<string, unknown>): Record<string, unknown> {
  const entries = asObjectRecord(agents.entries);
  return {
    ...agents,
    ...(Object.hasOwn(agents, "defaults")
      ? { defaults: migrateAgentModelScope(agents.defaults) }
      : {}),
    ...(entries
      ? {
          entries: Object.fromEntries(
            Object.entries(entries).map(([id, entry]) => [id, migrateAgentModelScope(entry)]),
          ),
        }
      : {}),
    // Core doctor may not yet have upgraded the shipped list shape to entries.
    ...(Array.isArray(agents.list) ? { list: agents.list.map(migrateAgentModelScope) } : {}),
  };
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const models = asObjectRecord(cfg.models);
  const providers = asObjectRecord(models?.providers);
  const legacyProvider = asObjectRecord(providers?.arcee);
  if (!legacyProvider || !isLegacyOpenRouterProvider(legacyProvider)) {
    return { config: cfg, changes: [] };
  }

  const currentOpenRouter = asObjectRecord(providers?.openrouter);
  const nextProviders = { ...providers };
  delete nextProviders.arcee;
  nextProviders.openrouter = buildCanonicalOpenRouterProvider({
    current: currentOpenRouter,
    legacy: legacyProvider,
  });

  const agents = asObjectRecord(cfg.agents);

  return {
    config: {
      ...cfg,
      models: {
        ...models,
        providers: nextProviders,
      } as OpenClawConfig["models"],
      ...(agents ? { agents: migrateAgentScopes(agents) as OpenClawConfig["agents"] } : {}),
    },
    changes: [
      `Moved the OpenRouter-backed Arcee catalog from ${LEGACY_PROVIDER_PATH} to ${CANONICAL_PROVIDER_PATH} and repaired its model references.`,
    ],
  };
}
