/**
 * Request-owned, metadata-only handoff for provider-owned generated catalogs.
 *
 * The per-agent SQLite cache holds the catalogs provider discovery validated for
 * the agent that owns it. A run that redirects state to a fresh directory cannot
 * rebuild them, so it carries the inventory metadata rather than the source
 * store: no credentials, request headers, request parameters, or database.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  isGeneratedPluginModelCatalog,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "./plugin-model-catalog-repair.js";
import type { PersistedPluginModelCatalog } from "./plugin-model-catalog.js";

/**
 * Provider route plus model inventory are the only fields a generated catalog
 * contributes to model resolution; credentials, request headers, request
 * parameters, and local-service environment stay in their owner's cache.
 */
const HANDOFF_PROVIDER_FIELDS = ["api", "baseUrl", "compat"] as const;
const HANDOFF_MODEL_FIELDS = [
  "id",
  "name",
  "api",
  "baseUrl",
  "compat",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "contextTokens",
  "maxTokens",
  "thinkingLevelMap",
  "mediaInput",
  "metadataSource",
  "agentRuntime",
] as const;

const PLUGIN_MODEL_CATALOG_HANDOFF_KEY = Symbol.for("openclaw.pluginModelCatalogHandoff");

const handoffStore = resolveGlobalSingleton<
  AsyncLocalStorage<readonly PersistedPluginModelCatalog[]>
>(PLUGIN_MODEL_CATALOG_HANDOFF_KEY, () => new AsyncLocalStorage());

function pickHandoffFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (value[field] !== undefined) {
      picked[field] = value[field];
    }
  }
  return picked;
}

/** Projects one generated catalog onto the metadata a run may carry with it. */
function projectPluginModelCatalogMetadata(
  catalog: PersistedPluginModelCatalog,
): PersistedPluginModelCatalog | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(catalog.contents) as unknown;
  } catch {
    return undefined;
  }
  if (!isGeneratedPluginModelCatalog(parsed) || !isRecord(parsed.providers)) {
    return undefined;
  }
  const providers: Record<string, unknown> = {};
  for (const [providerId, provider] of Object.entries(parsed.providers)) {
    if (!isRecord(provider)) {
      continue;
    }
    providers[providerId] = {
      ...pickHandoffFields(provider, HANDOFF_PROVIDER_FIELDS),
      models: (Array.isArray(provider.models) ? provider.models : [])
        .filter(isRecord)
        .map((model) => pickHandoffFields(model, HANDOFF_MODEL_FIELDS)),
    };
  }
  if (Object.keys(providers).length === 0) {
    return undefined;
  }
  return {
    pluginId: catalog.pluginId,
    contents: JSON.stringify({ generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers }),
  };
}

/**
 * Captures operator-owned catalog metadata before a run redirects state. The
 * projection is metadata-only by construction: it never carries the source
 * database, credentials, request headers, or request parameters.
 *
 * The catalog owner is imported lazily so this module holds no static edge back
 * into it. Call this outside the run's own handoff scope.
 */
export async function capturePluginModelCatalogHandoff(
  agentDir: string,
): Promise<readonly PersistedPluginModelCatalog[]> {
  const { readPersistedPluginModelCatalogs } = await import("./plugin-model-catalog.js");
  return readPersistedPluginModelCatalogs(agentDir).flatMap((catalog) => {
    const metadata = projectPluginModelCatalogMetadata(catalog);
    return metadata ? [metadata] : [];
  });
}

/** Runs one bounded operation with operator-owned catalog metadata in scope. */
export function withPluginModelCatalogHandoff<T>(
  catalogs: readonly PersistedPluginModelCatalog[],
  run: () => T,
): T {
  return catalogs.length === 0 ? run() : handoffStore.run(catalogs, run);
}

/**
 * Keeps retained local catalogs authoritative and only fills plugin ids the
 * local store does not retain at all, so an isolated run cannot shadow its own
 * state with handed-off metadata.
 */
export function withHandedOffPluginModelCatalogs(
  catalogs: readonly PersistedPluginModelCatalog[],
): PersistedPluginModelCatalog[] {
  const handoff = handoffStore.getStore();
  if (!handoff?.length) {
    return [...catalogs];
  }
  const retained = new Set(catalogs.map((catalog) => catalog.pluginId));
  const missing = handoff.filter((catalog) => !retained.has(catalog.pluginId));
  return missing.length === 0 ? [...catalogs] : [...catalogs, ...missing];
}
