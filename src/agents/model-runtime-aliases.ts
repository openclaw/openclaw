import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentRuntimePolicy } from "./agent-runtime-policy.js";
import {
  listDefaultModelAliasesForProvider,
  resolveDefaultModelAliasRef,
} from "./default-model-aliases.js";
import { normalizeProviderId } from "./provider-id.js";

type LegacyRuntimeModelProviderAlias = {
  /** Legacy provider id that encoded the runtime in the model ref. */
  legacyProvider: string;
  /** Canonical provider id that should own model selection. */
  provider: string;
  /** Runtime/backend id that preserves the old execution behavior. */
  runtime: string;
  /** True when the runtime is a CLI backend rather than an embedded harness. */
  cli: boolean;
};

const LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES = [
  { legacyProvider: "codex", provider: "openai", runtime: "codex", cli: false },
  { legacyProvider: "codex-cli", provider: "openai", runtime: "codex-cli", cli: true },
  { legacyProvider: "claude-cli", provider: "anthropic", runtime: "claude-cli", cli: true },
  {
    legacyProvider: "google-gemini-cli",
    provider: "google",
    runtime: "google-gemini-cli",
    cli: true,
  },
] as const satisfies readonly LegacyRuntimeModelProviderAlias[];

const LEGACY_ALIAS_BY_PROVIDER = new Map(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.map((entry) => [
    normalizeProviderId(entry.legacyProvider),
    entry,
  ]),
);

const CLI_RUNTIME_BY_PROVIDER = new Map(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) => [
    `${normalizeProviderId(entry.provider)}:${normalizeProviderId(entry.runtime)}`,
    entry,
  ]),
);

const CLI_RUNTIME_ALIASES = new Set(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) =>
    normalizeProviderId(entry.runtime),
  ),
);

export function listLegacyRuntimeModelProviderAliases(): readonly LegacyRuntimeModelProviderAlias[] {
  return LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES;
}

function resolveLegacyRuntimeModelProviderAlias(
  provider: string,
): LegacyRuntimeModelProviderAlias | undefined {
  return LEGACY_ALIAS_BY_PROVIDER.get(normalizeProviderId(provider));
}

type MigratedLegacyRuntimeModelRef = {
  ref: string;
  legacyProvider: string;
  provider: string;
  model: string;
  runtime: string;
  cli: boolean;
  sourceModelAlias?: string;
};

function parseProviderModelRef(raw: string): { provider: string; model: string } | null {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  const model = trimmed.slice(slash + 1).trim();
  return provider && model ? { provider, model } : null;
}

export function migrateLegacyRuntimeModelRef(raw: string): MigratedLegacyRuntimeModelRef | null {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  const alias = resolveLegacyRuntimeModelProviderAlias(trimmed.slice(0, slash));
  if (!alias) {
    return null;
  }
  const model = trimmed.slice(slash + 1).trim();
  if (!model) {
    return null;
  }
  return {
    ref: `${alias.provider}/${model}`,
    legacyProvider: alias.legacyProvider,
    provider: alias.provider,
    model,
    runtime: alias.runtime,
    cli: alias.cli,
  };
}

export function resolveLegacyRuntimeCanonicalModelRef(
  raw: string,
): MigratedLegacyRuntimeModelRef | null {
  const migrated = migrateLegacyRuntimeModelRef(raw);
  if (!migrated) {
    return null;
  }
  const aliasRef = resolveDefaultModelAliasRef(migrated.model);
  const parsedAlias = aliasRef ? parseProviderModelRef(aliasRef) : null;
  if (!parsedAlias || parsedAlias.provider !== migrated.provider) {
    return migrated;
  }
  return {
    ...migrated,
    ref: `${parsedAlias.provider}/${parsedAlias.model}`,
    provider: parsedAlias.provider,
    model: parsedAlias.model,
    sourceModelAlias: migrated.model,
  };
}

export function resolveCanonicalModelAliasForProvider(params: {
  provider: string;
  model: string;
}): { provider: string; model: string; sourceModelAlias?: string } | null {
  const provider = normalizeProviderId(params.provider);
  const model = params.model.trim();
  if (!provider || !model) {
    return null;
  }
  const legacy = resolveLegacyRuntimeCanonicalModelRef(`${provider}/${model}`);
  if (legacy?.sourceModelAlias) {
    return {
      provider: legacy.provider,
      model: legacy.model,
      sourceModelAlias: legacy.sourceModelAlias,
    };
  }
  const aliasRef = resolveDefaultModelAliasRef(model);
  const parsedAlias = aliasRef ? parseProviderModelRef(aliasRef) : null;
  if (!parsedAlias || parsedAlias.provider !== provider) {
    return null;
  }
  return {
    provider: parsedAlias.provider,
    model: parsedAlias.model,
    sourceModelAlias: model,
  };
}

export function buildLegacyRuntimeModelAliasHint(provider: string): string | undefined {
  const alias = resolveLegacyRuntimeModelProviderAlias(provider);
  if (!alias) {
    return undefined;
  }
  const aliases = listDefaultModelAliasesForProvider(alias.provider).map(
    (modelAlias) => `${alias.legacyProvider}/${modelAlias}`,
  );
  if (aliases.length === 0) {
    return undefined;
  }
  return `Known ${alias.legacyProvider} aliases resolve through ${alias.provider}: ${aliases.join(", ")}.`;
}

export function isLegacyRuntimeModelProvider(provider: string): boolean {
  return Boolean(resolveLegacyRuntimeModelProviderAlias(provider));
}

export function isCliRuntimeAlias(runtime: string | undefined): boolean {
  const normalized = runtime?.trim();
  return normalized ? CLI_RUNTIME_ALIASES.has(normalizeProviderId(normalized)) : false;
}

function resolveConfiguredRuntime(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  runtimeOverride?: string;
}): string | undefined {
  const override = params.runtimeOverride?.trim();
  if (override) {
    return normalizeProviderId(override);
  }
  if (params.agentId) {
    const agentEntry = params.cfg?.agents?.list?.find(
      (entry) => normalizeAgentId(entry.id) === normalizeAgentId(params.agentId ?? ""),
    );
    const agentRuntime = resolveAgentRuntimePolicy(agentEntry)?.id?.trim();
    if (agentRuntime) {
      return normalizeProviderId(agentRuntime);
    }
  }
  const defaults = resolveAgentRuntimePolicy(params.cfg?.agents?.defaults)?.id?.trim();
  if (defaults) {
    return normalizeProviderId(defaults);
  }
  return undefined;
}

export function resolveCliRuntimeExecutionProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  runtimeOverride?: string;
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  const runtime = resolveConfiguredRuntime(params);
  if (!runtime || runtime === "auto" || runtime === "pi") {
    return undefined;
  }
  return CLI_RUNTIME_BY_PROVIDER.get(`${provider}:${runtime}`)?.runtime;
}
