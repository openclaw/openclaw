import type { InternalSessionEntry } from "../config/sessions.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export function makeSuccessResult(provider: string, model: string) {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 100,
      aborted: false,
      stopReason: "end_turn",
      agentMeta: { provider, model },
    },
  };
}

export type CommandSessionEntryFixture = Partial<InternalSessionEntry> & {
  channel?: string;
  deliveryContext?: DeliveryContext;
  lastThreadId?: string | number;
};

export function createCommandSessionEntry(
  overrides: CommandSessionEntryFixture = {},
): InternalSessionEntry {
  return normalizeLegacySessionEntryDelivery({
    sessionId: "session-1",
    updatedAt: 1,
    ...overrides,
  } as InternalSessionEntry);
}

export function createCommandSessionFixture(
  overrides: CommandSessionEntryFixture = {},
  sessionKey = "agent:main:main",
): { entry: InternalSessionEntry; store: Record<string, InternalSessionEntry> } {
  const entry = createCommandSessionEntry({
    skillsSnapshot: { prompt: "", skills: [], version: 0 },
    ...overrides,
  });
  return { entry, store: { [sessionKey]: entry } };
}

export function createChannelModelRuntimeConfig({
  channel = "discord",
  matchKey = "channel-123",
  model = "openai/channel-model",
  additionalModels = {},
}: {
  channel?: string;
  matchKey?: string;
  model?: string;
  additionalModels?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    agents: {
      defaults: {
        model: "anthropic/default-model",
        models: {
          "anthropic/default-model": {},
          [model]: {},
          ...additionalModels,
        },
      },
    },
    channels: { modelByChannel: { [channel]: { [matchKey]: model } } },
  };
}

export function createConfiguredModelCompatRuntimeConfig(allowlisted: boolean, excluded = false) {
  return {
    agents: {
      defaults: {
        model: { primary: "gmn/gpt-5.4" },
        ...(allowlisted ? { models: { "gmn/gpt-5.4": {} } } : {}),
        ...(excluded ? { modelPolicy: { allow: ["gmn/manual"] } } : {}),
      },
    },
    models: {
      providers: {
        gmn: {
          models: [
            {
              id: "gpt-5.4",
              name: "GPT 5.4 via GMN",
              reasoning: true,
              compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
            },
            ...(excluded ? [{ id: "manual", name: "Manual", reasoning: false }] : []),
          ],
        },
      },
    },
  };
}

type ModelCatalogEntry = {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  compat?: unknown;
};

type ModelSelectionParams = {
  cfg?: unknown;
  catalog?: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
};

const normalizeTestProviderId = (provider: string) => provider.trim().toLowerCase();

function isTestModelKeyAllowed(allowedKeys: ReadonlySet<string>, key: string): boolean {
  if (allowedKeys.has(key)) {
    return true;
  }
  let separator = key.indexOf("/");
  while (separator > 0) {
    if (allowedKeys.has(`${key.slice(0, separator + 1)}*`)) {
      return true;
    }
    separator = key.indexOf("/", separator + 1);
  }
  return false;
}

function buildTestConfiguredModelCatalog(cfg?: unknown): ModelCatalogEntry[] {
  const providers = (
    cfg as {
      models?: {
        providers?: Record<string, { api?: unknown; baseUrl?: unknown; models?: unknown[] }>;
      };
    }
  )?.models?.providers;
  if (!providers) {
    return [];
  }
  return Object.entries(providers).flatMap(([provider, entry]) =>
    Array.isArray(entry?.models)
      ? entry.models
          .filter(
            (model): model is Record<string, unknown> =>
              Boolean(model) && typeof model === "object",
          )
          .map((model) => {
            const id = typeof model.id === "string" ? model.id : "";
            return {
              provider,
              id,
              name: typeof model.name === "string" ? model.name : id,
              api:
                typeof model.api === "string"
                  ? model.api
                  : typeof entry.api === "string"
                    ? entry.api
                    : undefined,
              baseUrl:
                typeof model.baseUrl === "string"
                  ? model.baseUrl
                  : typeof entry.baseUrl === "string"
                    ? entry.baseUrl
                    : undefined,
              reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
              compat: model.compat,
            };
          })
          .filter((model) => model.id)
      : [],
  );
}

function buildTestAllowedModelSet({
  cfg,
  catalog,
  defaultProvider,
  defaultModel,
}: ModelSelectionParams) {
  const modelMap =
    (cfg as { agents?: { defaults?: { models?: Record<string, unknown> } } } | undefined)?.agents
      ?.defaults?.models ?? {};
  const allowedKeys = new Set(Object.keys(modelMap));
  if (defaultModel) {
    allowedKeys.add(`${defaultProvider}/${defaultModel}`);
  }
  const allowedCatalog = [...(catalog ?? []), ...buildTestConfiguredModelCatalog(cfg)];
  if (Object.keys(modelMap).length === 0) {
    return { allowedKeys, allowedCatalog, allowAny: true };
  }
  return {
    allowedKeys,
    allowedCatalog: allowedCatalog.filter((entry) =>
      isTestModelKeyAllowed(allowedKeys, `${entry.provider}/${entry.id}`),
    ),
    allowAny: false,
  };
}

export function createTestModelVisibilityPolicy(params: ModelSelectionParams) {
  const allowed = buildTestAllowedModelSet(params);
  const wildcardModelKeys = new Set([...allowed.allowedKeys].filter((key) => key.endsWith("/*")));
  const allowsKey = (key: string) =>
    allowed.allowAny || isTestModelKeyAllowed(allowed.allowedKeys, key);
  return {
    ...allowed,
    catalog: [...(params.catalog ?? []), ...buildTestConfiguredModelCatalog(params.cfg)],
    exactModelRefs: [],
    providerWildcards: new Set<string>(),
    hasConfiguredEntries: !allowed.allowAny,
    hasProviderWildcards: wildcardModelKeys.size > 0,
    allows: ({ provider, model }: { provider: string; model: string }) =>
      allowsKey(`${provider}/${model}`),
    allowsByWildcard: ({ provider, model }: { provider: string; model: string }) =>
      isTestModelKeyAllowed(wildcardModelKeys, `${provider}/${model}`),
    resolveSelection: ({ provider, model }: { provider: string; model: string }) => {
      if (allowsKey(`${provider}/${model}`)) {
        return { provider, model };
      }
      const fallback = allowed.allowedCatalog[0];
      return fallback ? { provider: fallback.provider, model: fallback.id } : null;
    },
    visibleCatalog: ({ catalog }: { catalog: ModelCatalogEntry[] }) => catalog,
  };
}

function buildTestModelAliasIndex({
  cfg,
}: {
  cfg?: { agents?: { defaults?: { models?: Record<string, { alias?: string }> } } };
}) {
  const byAlias = new Map<string, { alias: string; ref: { provider: string; model: string } }>();
  const byKey = new Map<string, string[]>();
  for (const [ref, entry] of Object.entries(cfg?.agents?.defaults?.models ?? {})) {
    const alias = entry?.alias?.trim();
    if (!alias) {
      continue;
    }
    const [provider, ...modelParts] = ref.split("/");
    if (!provider) {
      throw new Error(`expected provider in model ref ${ref}`);
    }
    const model = modelParts.join("/");
    byAlias.set(alias.toLowerCase(), { alias, ref: { provider, model } });
    byKey.set(`${provider}/${model}`, [alias]);
  }
  return { byAlias, byKey };
}

function resolveTestModelRefFromString({
  raw,
  defaultProvider,
  aliasIndex,
}: {
  raw: string;
  defaultProvider: string;
  aliasIndex?: ReturnType<typeof buildTestModelAliasIndex>;
}) {
  const aliasMatch = aliasIndex?.byAlias.get(raw.trim().toLowerCase());
  if (aliasMatch) {
    return { ref: aliasMatch.ref, alias: aliasMatch.alias };
  }
  const slash = raw.indexOf("/");
  return {
    ref:
      slash > 0
        ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
        : { provider: defaultProvider, model: raw },
  };
}

function resolveTestModelAliasFromPair(params: {
  provider: string;
  model: string;
  defaultProvider: string;
  aliasIndex?: ReturnType<typeof buildTestModelAliasIndex>;
}) {
  const bareAlias = resolveTestModelRefFromString({
    raw: params.model,
    defaultProvider: params.provider,
    aliasIndex: params.aliasIndex,
  });
  const providerAlias = resolveTestModelRefFromString({
    raw: `${params.provider}/${params.model}`,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  });
  if (providerAlias.alias) {
    return providerAlias.ref;
  }
  const provider = normalizeTestProviderId(params.provider);
  return bareAlias.alias &&
    (normalizeTestProviderId(bareAlias.ref.provider) === provider ||
      provider === normalizeTestProviderId(params.defaultProvider))
    ? bareAlias.ref
    : null;
}

function configuredPrimary(cfg?: unknown): string {
  const raw = (cfg as { agents?: { defaults?: { model?: string | { primary?: string } } } })?.agents
    ?.defaults?.model;
  return (typeof raw === "string" ? raw : raw?.primary) ?? "anthropic/claude";
}

function resolveTestConfiguredModelRef({ cfg }: { cfg?: unknown }) {
  const [provider = "anthropic", ...modelParts] = configuredPrimary(cfg).split("/");
  return { provider, model: modelParts.join("/") || "claude" };
}

function resolveTestDefaultModelForAgent({ cfg }: { cfg?: unknown }) {
  const { provider, model: modelWithProfile } = resolveTestConfiguredModelRef({ cfg });
  const [model = "claude", authProfileId] = modelWithProfile.split("@");
  return { provider, model, ...(authProfileId ? { authProfileId } : {}) };
}

export function createTestModelSelection(params: {
  resolveThinkingDefaultMock: (args: unknown) => unknown;
}) {
  return {
    buildAllowedModelSet: buildTestAllowedModelSet,
    createModelVisibilityPolicy: createTestModelVisibilityPolicy,
    buildConfiguredModelCatalog: ({ cfg }: { cfg?: unknown }) =>
      buildTestConfiguredModelCatalog(cfg),
    isModelKeyAllowedBySet: isTestModelKeyAllowed,
    buildModelAliasIndex: buildTestModelAliasIndex,
    modelKey: (provider: string, model: string) => `${provider}/${model}`,
    normalizeModelRef: (provider: string, model: string) => ({
      provider: normalizeTestProviderId(provider),
      model,
    }),
    normalizeProviderId: normalizeTestProviderId,
    normalizeProviderIdForAuth: normalizeTestProviderId,
    parseModelRef: (model: string, provider: string) => {
      const slash = model.indexOf("/");
      return slash > 0
        ? { provider: model.slice(0, slash), model: model.slice(slash + 1) }
        : { provider, model };
    },
    resolveModelRefFromString: resolveTestModelRefFromString,
    resolveModelAliasFromPair: resolveTestModelAliasFromPair,
    resolveConfiguredModelRef: resolveTestConfiguredModelRef,
    resolveDefaultModelForAgent: resolveTestDefaultModelForAgent,
    resolveThinkingDefault: (args: unknown) => params.resolveThinkingDefaultMock(args),
  };
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}
