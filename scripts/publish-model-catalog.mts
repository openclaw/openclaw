import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import {
  MODEL_PRICING_SOURCES,
  OPENROUTER_DECISION_MODELS_URL,
  normalizeModelPricingCatalog,
  normalizeModelPricingProvider,
  normalizeOpenRouterModelPricing,
  normalizeUpstreamModelPricing,
  type ModelPricingProvider,
  type ModelPricingSource,
} from "@openclaw/model-catalog-core/model-catalog-pricing";
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ModelCatalogModel } from "../packages/model-catalog-core/src/model-catalog-types.js";
import type {
  RemoteModelCatalogBundle,
  RemoteModelCatalogPricing,
} from "../packages/model-catalog-core/src/remote-catalog-bundle.js";
import { importToolingTypeScript } from "./lib/import-tooling-typescript.mts";
import {
  createModelCatalogSourceLoader,
  hydrateModelCatalogFromModelsDev,
  type ModelCatalogManifestInput,
  type ModelCatalogSourceLoader,
} from "./lib/model-catalog-publication-source.mts";
import {
  loadClientBundleValidator,
  compactPricing,
  hasKnownPricing,
  assembleModelCatalogBundleV2,
  assembleModelCatalogBundleV3,
  serializeModelCatalogBundle,
  serializeModelCatalogBundleV2,
  projectLegacyModelCatalogBundle,
  type PricingSelection,
  type StandalonePricing,
} from "./lib/model-catalog-publication-wire.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

export { hydrateModelCatalogFromModelsDev } from "./lib/model-catalog-publication-source.mts";
export {
  assembleModelCatalogBundleV2,
  serializeModelCatalogBundle,
  serializeModelCatalogBundleV2,
} from "./lib/model-catalog-publication-wire.mts";

type PublishedModelPricing = RemoteModelCatalogPricing;
type PublishedModelCatalogBundle = RemoteModelCatalogBundle;
type PricingPolicies = Map<string, ModelPricingProvider>;
type PricingCatalog = Map<string, PublishedModelPricing>;
type PricingSource = (typeof MODEL_PRICING_SOURCES)[number];
type LoadedPricingSource = PricingSource & {
  catalog: PricingCatalog;
  aliases: string[][];
  decisionCatalog?: PricingCatalog;
};
type BundleValidator = (bundle: unknown) => PublishedModelCatalogBundle;
const MODEL_CATALOG_MIN_VERSION = "2026.7.0";
export const MODEL_CATALOG_MIN_MODELS = 200;

const SCRIPT_LABEL = "publish-model-catalog";
const BUNDLE_SIZE_WARNING_BYTES = 2 * 1024 * 1024;
const CLIENT_BUNDLE_LIMIT_BYTES = 4 * 1024 * 1024;
const defaultRootDir = resolveRepoRoot(import.meta.url);
const NATIVE_CATALOG_PARSER_EXPORTS = {
  cerebras: "parseCerebrasPricingCatalog",
  chutes: "parseChutesPricingCatalog",
  deepinfra: "parseDeepInfraPricingCatalog",
  venice: "parseVenicePricingCatalog",
} satisfies Record<
  Exclude<Extract<PricingSource, { authoritative: true }>["id"], "openCode">,
  string
>;

function requireOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parsePublishModelCatalogArgs(args: string[]) {
  let dryRun = false;
  let pricing = false;
  let out: string | undefined;
  let outV2: string | undefined;
  let outV3: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--pricing") {
      pricing = true;
      continue;
    }
    if (arg === "--out") {
      out = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out-v2") {
      outV2 = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out-v3") {
      outV3 = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!dryRun && !out) {
    throw new Error("provide --out <file> or --dry-run");
  }
  return {
    dryRun,
    pricing,
    ...(out ? { out } : {}),
    ...(outV2 ? { outV2 } : {}),
    ...(outV3 ? { outV3 } : {}),
  };
}

export function readModelCatalogManifests(
  options: { rootDir?: string } = {},
): ModelCatalogManifestInput[] {
  const rootDir = options.rootDir ?? defaultRootDir;
  const extensionsDir = path.join(rootDir, "extensions");
  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      pluginId: entry.name,
      manifestPath: path.join(extensionsDir, entry.name, "openclaw.plugin.json"),
    }))
    .filter((entry) => fs.existsSync(entry.manifestPath))
    .map((entry) => ({
      pluginId: entry.pluginId,
      manifestPath: entry.manifestPath,
      manifest: JSON.parse(fs.readFileSync(entry.manifestPath, "utf8")),
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export async function assembleModelCatalogBundle(options: {
  manifests: ModelCatalogManifestInput[];
  generatedAt: number;
  sourceCommit: string;
  minVersion?: string;
  validateBundle?: BundleValidator;
}): Promise<PublishedModelCatalogBundle> {
  const providers: Record<string, unknown> = {};
  for (const entry of options.manifests) {
    const declaredProviders = entry.manifest?.modelCatalog?.providers;
    if (!isRecord(declaredProviders)) {
      continue;
    }
    for (const [providerId, provider] of Object.entries(declaredProviders)) {
      if (Object.hasOwn(providers, providerId)) {
        throw new Error(`provider ${providerId} is declared by more than one plugin manifest`);
      }
      if (!isRecord(provider)) {
        throw new Error("invalid provider catalog declaration");
      }
      // Public facts only: plugin credential scope and runtime hooks never cross this boundary.
      providers[providerId] = {
        api: provider.api,
        defaultModel: provider.defaultModel,
        defaultUtilityModel: provider.defaultUtilityModel,
        models: provider.models,
      };
    }
  }

  if (!Object.hasOwn(providers, "anthropic") || !Object.hasOwn(providers, "openai")) {
    throw new Error("catalog must include anthropic and openai providers");
  }
  const bundle = {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    minVersion: options.minVersion ?? MODEL_CATALOG_MIN_VERSION,
    sourceCommit: options.sourceCommit,
    providers,
  };
  const validateBundle = options.validateBundle ?? (await loadClientBundleValidator());
  const validated = validateBundle(bundle);
  const summary = summarizeModelCatalogBundle(validated);
  if (summary.models < MODEL_CATALOG_MIN_MODELS) {
    throw new Error(
      `catalog model count ${summary.models} is below required floor ${MODEL_CATALOG_MIN_MODELS}`,
    );
  }
  return validated;
}

export function summarizeModelCatalogBundle(bundle: PublishedModelCatalogBundle) {
  const providerRows = Object.values(bundle.providers);
  return {
    providers: providerRows.length,
    models: providerRows.reduce((total, provider) => total + provider.models.length, 0),
    costModels: providerRows.reduce(
      (total, provider) => total + provider.models.filter((model) => model.cost).length,
      0,
    ),
    pricingEntries: Object.keys(bundle.pricing ?? {}).length,
  };
}

function toPricePerMillion(value: number | undefined): number {
  return value === undefined || value < 0 ? 0 : value * 1_000_000;
}

function parseLiteLLMTieredPricing(
  value: unknown,
): PublishedModelPricing["tieredPricing"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tiers: NonNullable<PublishedModelPricing["tieredPricing"]> = [];
  for (const raw of value) {
    if (!isRecord(raw) || !Array.isArray(raw.range)) {
      continue;
    }
    const input = parseStrictFiniteNumber(raw.input_cost_per_token);
    const output = parseStrictFiniteNumber(raw.output_cost_per_token);
    const start = parseStrictFiniteNumber(raw.range[0]);
    if (
      input === undefined ||
      output === undefined ||
      start === undefined ||
      input < 0 ||
      output < 0
    ) {
      continue;
    }
    const rawEnd = raw.range.length >= 2 ? parseStrictFiniteNumber(raw.range[1]) : undefined;
    const range: [number] | [number, number] =
      rawEnd === undefined || rawEnd <= start ? [start] : [start, rawEnd];
    tiers.push({
      input: toPricePerMillion(input),
      output: toPricePerMillion(output),
      cacheRead: toPricePerMillion(parseStrictFiniteNumber(raw.cache_read_input_token_cost)),
      cacheWrite: toPricePerMillion(parseStrictFiniteNumber(raw.cache_creation_input_token_cost)),
      range,
    });
  }
  return tiers.length > 0
    ? tiers.toSorted((left, right) => left.range[0] - right.range[0])
    : undefined;
}

function parseLiteLLMPricing(value: unknown): PublishedModelPricing | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = parseStrictFiniteNumber(value.input_cost_per_token);
  const output = parseStrictFiniteNumber(value.output_cost_per_token);
  if (input === undefined || output === undefined || input < 0 || output < 0) {
    return undefined;
  }
  const tieredPricing = parseLiteLLMTieredPricing(value.tiered_pricing);
  return {
    input: toPricePerMillion(input),
    output: toPricePerMillion(output),
    cacheRead: toPricePerMillion(parseStrictFiniteNumber(value.cache_read_input_token_cost)),
    cacheWrite: toPricePerMillion(parseStrictFiniteNumber(value.cache_creation_input_token_cost)),
    ...(tieredPricing ? { tieredPricing } : {}),
  };
}

function modelIdVariants(modelId: string, transforms?: string[], reverse = false): string[] {
  if (!transforms?.includes("version-dots")) {
    return [modelId];
  }
  const variant = reverse
    ? modelId
        .replace(/^claude-(\d+)\.(\d+)-/u, "claude-$1-$2-")
        .replace(/^claude-([a-z]+)-(\d+)\.(\d+)$/u, "claude-$1-$2-$3")
    : modelId
        .replace(/^claude-(\d+)-(\d+)-/u, "claude-$1.$2-")
        .replace(/^claude-([a-z]+)-(\d+)-(\d+)$/u, "claude-$1-$2.$3");
  return [...new Set([modelId, variant])];
}

function sourcePolicy(
  policies: PricingPolicies,
  providerId: string,
  source: PricingSource,
): ModelPricingSource | undefined {
  const policy = policies.get(providerId);
  const selected = policy?.[source.id];
  if (
    policy?.external === false ||
    selected === false ||
    (!selected && (policy || source.authoritative))
  ) {
    return undefined;
  }
  return selected ?? {};
}

function buildPricingCandidates(
  providerId: string,
  modelId: string,
  source: PricingSource,
  policies: PricingPolicies,
  seen = new Set<string>(),
): string[] {
  const ref = `${providerId}/${modelId}`;
  const policy = sourcePolicy(policies, providerId, source);
  if (seen.has(ref) || !policy) {
    return [];
  }
  // models.dev prices are pre-keyed by OpenClaw provider; `provider` only picks the entry.
  const namespace = source.id === "modelsDev" ? providerId : (policy.provider ?? providerId);
  const candidates = modelIdVariants(modelId, policy.modelIdTransforms).map(
    (id) => `${namespace}/${id}`,
  );
  const slash = modelId.indexOf("/");
  if (policy.passthroughProviderModel && slash > 0) {
    candidates.push(
      ...buildPricingCandidates(
        modelId.slice(0, slash),
        modelId.slice(slash + 1),
        source,
        policies,
        new Set(seen).add(ref),
      ),
    );
  }
  return [...new Set(candidates)];
}

function readPricingPolicies(manifests: ModelCatalogManifestInput[]): PricingPolicies {
  const policies: PricingPolicies = new Map();
  for (const { manifest } of manifests) {
    const owners = new Set((manifest.providers ?? []).map(normalizeModelCatalogProviderId));
    for (const [rawId, value] of Object.entries(manifest.modelPricing?.providers ?? {})) {
      const id = normalizeModelCatalogProviderId(rawId);
      const policy = owners.has(id) ? normalizeModelPricingProvider(value) : undefined;
      if (policy) {
        policies.set(id, policy);
      }
    }
  }
  return policies;
}

/** Maps each OpenClaw provider to the models.dev entry that bills it. */
function readModelsDevPricingProviders(
  manifests: ModelCatalogManifestInput[],
  policies: PricingPolicies,
): Map<string, string> {
  const providers = new Map<string, string>();
  for (const { manifest } of manifests) {
    const ownedProviders = new Set((manifest.providers ?? []).map(normalizeModelCatalogProviderId));
    // The metadata mapping names the same billing entry unless pricing policy overrides it.
    const mapped = normalizeModelCatalog(manifest.modelCatalog, { ownedProviders })?.modelsDev;
    for (const providerId of ownedProviders) {
      const policy = policies.get(providerId)?.modelsDev;
      const named = (policy && policy.provider) || mapped?.[providerId];
      // A pass-through gateway has its own price list only when its manifest names one;
      // otherwise it bills the vendor's rate (Cloudflare Unified Billing, for example).
      if (named || !(policy && policy.passthroughProviderModel)) {
        providers.set(providerId, named || providerId);
      }
    }
  }
  return providers;
}

async function parsePricingCatalog(
  source: PricingSource,
  body: unknown,
  policies: PricingPolicies,
  modelsDevProviders: ReadonlyMap<string, string>,
): Promise<LoadedPricingSource> {
  const catalog: PricingCatalog = new Map();
  const aliases: string[][] = [];
  if (source.authoritative && source.id !== "openCode") {
    const moduleUrl = new URL(`../extensions/${source.id}/pricing-api.ts`, import.meta.url).href;
    const module = await importToolingTypeScript(moduleUrl, import.meta.url);
    const parser = module[NATIVE_CATALOG_PARSER_EXPORTS[source.id]];
    if (typeof parser !== "function") {
      throw new Error(`${source.label} pricing parser export is unavailable`);
    }
    const prices = parser(body);
    if (!prices) {
      throw new Error(`${source.label} pricing response is malformed`);
    }
    for (const [id, pricing] of prices) {
      catalog.set(`${source.id}/${id}`, pricing);
    }
    return { ...source, catalog, aliases };
  }
  if (!isRecord(body)) {
    throw new Error(`${source.label} response is not a JSON object`);
  }
  if (source.id === "openCode") {
    for (const [providerId] of policies) {
      const policy = sourcePolicy(policies, providerId, source);
      if (!policy) {
        continue;
      }
      const upstreamId = policy.provider ?? providerId;
      const provider = body[upstreamId];
      if (!isRecord(provider) || provider.id !== upstreamId || !isRecord(provider.models)) {
        throw new Error(`${source.label} pricing missing provider ${upstreamId}`);
      }
      const rows = Object.entries(provider.models).map(([id, model]) =>
        isRecord(model) && model.id === id ? model : undefined,
      );
      const prices = normalizeModelPricingCatalog(rows, normalizeUpstreamModelPricing, {
        readPricing: (model) => model.cost,
      });
      if (!prices) {
        throw new Error(`${source.label} pricing malformed for provider ${upstreamId}`);
      }
      for (const [id, pricing] of prices) {
        catalog.set(`${upstreamId}/${id}`, pricing);
      }
    }
  } else if (source.id === "modelsDev") {
    // Each OpenClaw provider reads the models.dev entry that bills it, keyed in its own
    // namespace for its catalog rows. Vendors are also keyed under their models.dev slug
    // (`moonshotai/…`), the `vendor/model` ID that gateways pass through.
    const gateways = readPassthroughProviders(policies);
    for (const [providerId, upstreamId] of modelsDevProviders) {
      if (!sourcePolicy(policies, providerId, source)) {
        continue;
      }
      const provider = body[upstreamId];
      if (!isRecord(provider) || provider.id !== upstreamId || !isRecord(provider.models)) {
        continue;
      }
      const rows = Object.entries(provider.models).map(([id, model]) =>
        isRecord(model) && model.id === id ? model : undefined,
      );
      const prices = normalizeModelPricingCatalog(rows, normalizeUpstreamModelPricing, {
        readPricing: (model) => model.cost,
      });
      if (!prices) {
        process.stderr.write(
          `[${SCRIPT_LABEL}] warning: models.dev pricing malformed for provider ${upstreamId}; skipping it\n`,
        );
        continue;
      }
      for (const [id, pricing] of prices) {
        catalog.set(`${providerId}/${id}`, pricing);
        if (upstreamId !== providerId && !gateways.has(providerId)) {
          catalog.set(`${upstreamId}/${id}`, pricing);
        }
      }
    }
  } else if (source.id === "openRouter") {
    // OpenRouter's feed is OpenRouter's billing, promotions included. Its IDs look like
    // vendor keys (`openai/gpt-…`), so namespace them to price only OpenRouter routes.
    for (const row of Array.isArray(body.data) ? body.data : []) {
      if (!isRecord(row)) {
        continue;
      }
      const pricing = normalizeOpenRouterModelPricing(row.pricing);
      if (typeof row.id === "string" && pricing) {
        catalog.set(`openrouter/${row.id}`, pricing);
      }
    }
  } else {
    for (const [id, row] of Object.entries(body)) {
      const pricing = parseLiteLLMPricing(row);
      if (!pricing || !isRecord(row)) {
        continue;
      }
      const keys = [id];
      if (typeof row.litellm_provider === "string" && !id.includes("/")) {
        keys.push(`${row.litellm_provider}/${id}`);
      }
      for (const key of keys) {
        catalog.set(key, pricing);
      }
      aliases.push(keys);
    }
  }
  // Only a native billing owner establishes an advertised free tariff. Third-party zero
  // rows may be placeholders; positive third-party estimates retain their existing policy.
  if (!source.authoritative && source.id !== "openRouter") {
    for (const [key, pricing] of catalog) {
      if (!hasKnownPricing(pricing)) {
        catalog.delete(key);
      }
    }
  }
  return { ...source, catalog, aliases };
}

async function fetchPricingSources(
  loadSource: ModelCatalogSourceLoader,
  policies: PricingPolicies,
  modelsDevProviders: ReadonlyMap<string, string>,
) {
  const sources = MODEL_PRICING_SOURCES.filter(
    (source) =>
      !source.authoritative ||
      [...policies.keys()].some((id) => sourcePolicy(policies, id, source)),
  );
  const loaded = await Promise.all(
    sources.map(async (source) => {
      try {
        const body = await loadSource(source.url, source.label);
        const parsed = await parsePricingCatalog(source, body, policies, modelsDevProviders);
        if (source.id === "openRouter") {
          try {
            const native = await loadSource(OPENROUTER_DECISION_MODELS_URL, "OpenRouter decisions");
            const decisionCatalog: PricingCatalog = new Map();
            for (const row of isRecord(native) && Array.isArray(native.data) ? native.data : []) {
              if (!isRecord(row) || typeof row.id !== "string") {
                continue;
              }
              const pricing = normalizeOpenRouterModelPricing(row.pricing, { tokenOnly: true });
              if (pricing) {
                decisionCatalog.set("openrouter/" + row.id, pricing);
              }
            }
            parsed.decisionCatalog = decisionCatalog;
            // Pricing-only entries survive legacy publication, but never displace a chat tariff.
            for (const [key, pricing] of decisionCatalog) {
              if (!parsed.catalog.has(key)) {
                parsed.catalog.set(key, pricing);
              }
            }
          } catch (error) {
            process.stderr.write(
              "[publish-model-catalog] warning: decision pricing unavailable: " +
                String(error) +
                "\n",
            );
          }
        }
        return parsed;
      } catch (cause) {
        return {
          source,
          error: new Error(`${source.label} pricing unavailable: ${String(cause)}`, { cause }),
        };
      }
    }),
  );
  // Join all fetches before the final failure marker, and never re-stamp stale owner prices.
  const failure = loaded.find((entry) => "error" in entry && entry.source.authoritative);
  if (failure && "error" in failure) {
    throw failure.error;
  }
  const result: LoadedPricingSource[] = [];
  for (const entry of loaded) {
    if ("error" in entry) {
      process.stderr.write(`[${SCRIPT_LABEL}] warning: ${entry.error.message}\n`);
      result.push({ ...entry.source, catalog: new Map(), aliases: [] });
    } else {
      result.push(entry);
    }
  }
  return result;
}

function selectProviderPricingSources(
  providerId: string,
  sources: LoadedPricingSource[],
  policies: PricingPolicies,
): LoadedPricingSource[] {
  const eligible = sources.filter((source) => sourcePolicy(policies, providerId, source));
  // A native feed owns unavailable prices too; other vendors cannot fill its gaps.
  const native = eligible.find((source) => source.authoritative);
  return native ? [native] : eligible;
}

/** Providers that charge a vendor's price for `vendor/model` IDs, such as gateways. */
function readPassthroughProviders(policies: PricingPolicies): Set<string> {
  return new Set(
    [...policies].flatMap(([id, policy]) =>
      MODEL_PRICING_SOURCES.some(({ id: source }) => {
        const selected = policy[source];
        return selected && selected.passthroughProviderModel;
      })
        ? [id]
        : [],
    ),
  );
}

function materializePolicyRuntimePricing(
  hosted: PricingCatalog,
  policies: PricingPolicies,
  sources: LoadedPricingSource[],
  metadataOwnedKeys: Set<string>,
  gateways: ReadonlySet<string>,
  providerPrices?: StandalonePricing["provider"],
): void {
  for (const [providerId] of policies) {
    for (const key of hosted.keys()) {
      if (key.startsWith(`${providerId}/`)) {
        hosted.delete(key);
      }
    }
    const providerSources = selectProviderPricingSources(providerId, sources, policies);
    // A provider's own price from any source beats the vendor price it passes through.
    for (const passthrough of [false, true]) {
      for (const source of providerSources) {
        const policy = sourcePolicy(policies, providerId, source);
        if (!policy || (passthrough && !policy.passthroughProviderModel)) {
          continue;
        }
        const namespace = source.id === "modelsDev" ? providerId : (policy.provider ?? providerId);
        for (const [key, pricing] of source.catalog) {
          // Entries here passed the source parser: an advertised zero is not a seed placeholder.
          const slash = key.indexOf("/");
          if (slash <= 0 || slash === key.length - 1) {
            continue;
          }
          const runtimeKeys = passthrough
            ? gateways.has(key.slice(0, slash))
              ? []
              : [`${providerId}/${key}`]
            : key.slice(0, slash) === namespace
              ? modelIdVariants(key.slice(slash + 1), policy.modelIdTransforms, true).map(
                  (id) => `${providerId}/${id}`,
                )
              : [];
          for (const runtimeKey of runtimeKeys) {
            if (!metadataOwnedKeys.has(runtimeKey) && !hosted.has(runtimeKey)) {
              hosted.set(runtimeKey, pricing);
              // V2 resolves passthrough keys from the upstream table at lookup time.
              if (!passthrough) {
                providerPrices?.set(runtimeKey, { source: source.id, pricing });
              }
            }
          }
        }
      }
    }
  }
}

export async function enrichModelCatalogPricing(options: {
  bundle: PublishedModelCatalogBundle;
  manifests: ModelCatalogManifestInput[];
  fetchImpl?: typeof fetch;
  loadSource?: ModelCatalogSourceLoader;
  pricingSelections?: WeakMap<ModelCatalogModel, PricingSelection>;
  standalonePricing?: StandalonePricing;
}): Promise<{ modelsEnriched: number; pricingEntries: number }> {
  const policies = readPricingPolicies(options.manifests);
  const sources = await fetchPricingSources(
    options.loadSource ?? createModelCatalogSourceLoader(options.fetchImpl),
    policies,
    readModelsDevPricingProviders(options.manifests, policies),
  );
  let enriched = 0;
  const coveredKeys = new Set<string>();
  const metadataOwnedKeys = new Set<string>();
  for (const [providerId, provider] of Object.entries(options.bundle.providers)) {
    const providerSources = selectProviderPricingSources(providerId, sources, policies);
    for (const model of provider.models) {
      const matches = providerSources.map((source) => {
        const candidates = buildPricingCandidates(providerId, model.id, source, policies);
        const prices =
          source.id === "openRouter" && model.inference?.chat === false
            ? source.decisionCatalog
            : source.catalog;
        return {
          source,
          candidates,
          pricing: candidates.map((key) => prices?.get(key)).find(Boolean),
        };
      });
      // Flat third-party estimates cannot replace a declared context-price schedule.
      // Native feeds remain authoritative, including removal of old tiers or prices.
      const chosen = matches.find(
        ({ source, pricing }) =>
          source.authoritative ||
          (pricing && (!model.cost?.tieredPricing?.length || pricing.tieredPricing?.length)),
      );
      if (chosen?.pricing) {
        model.cost = chosen.pricing;
        options.pricingSelections?.set(model, { status: "known", source: chosen.source.id });
        enriched += 1;
      } else if (chosen) {
        // Keep the metadata row: removing it would revive the bundled seed's stale price.
        delete model.cost;
        options.pricingSelections?.set(model, { status: "unavailable", source: chosen.source.id });
        process.stderr.write(
          `[${SCRIPT_LABEL}] warning: ${chosen.source.label} pricing unavailable for ${providerId}/${model.id}; preserving metadata without cost\n`,
        );
      }
      const inference = model.inference;
      const decision = inference?.decision;
      const billing = decision?.billing;
      if (inference && decision && billing?.unit === "tokens") {
        const native = matches.flatMap(({ source, candidates }) =>
          candidates.flatMap((key) => {
            const rate = source.decisionCatalog?.get(key);
            return rate ? [{ rate, source }] : [];
          }),
        )[0];
        if (native) {
          const { usdPerMillion: _oldRates, ...billingFacts } = billing;
          model.inference = {
            ...inference,
            decision: {
              ...decision,
              billing: {
                ...billingFacts,
                source: "provider-catalog",
                ...(!native.rate.tieredPricing?.length
                  ? { usdPerMillion: { input: native.rate.input, output: native.rate.output } }
                  : {}),
              },
            },
          };
          if (!model.inference.chat) {
            model.cost = native.rate;
            options.pricingSelections?.set(model, { status: "known", source: native.source.id });
          }
        }
      }
      // Native zero prices keep standalone entries as evidence of free, not unknown, usage.
      if ((model.cost && hasKnownPricing(model.cost)) || (chosen && !chosen.pricing)) {
        const key = `${providerId}/${model.id}`;
        coveredKeys.add(key);
        metadataOwnedKeys.add(key);
        for (const { candidates } of matches) {
          for (const candidate of candidates) {
            coveredKeys.add(candidate);
          }
        }
      }
    }
  }

  const gateways = readPassthroughProviders(policies);
  const hosted: PricingCatalog = new Map();
  for (const source of sources) {
    // Opted-in feeds only enter the owner's mapped namespace, never the global fallback map.
    if (!source.authoritative) {
      for (const [key, pricing] of source.catalog) {
        const existing = hosted.get(key);
        if (!existing) {
          hosted.set(key, pricing);
        }
        // Unpruned: gateways pass through to catalogued vendor models too. A gateway's own
        // keys are its billing, served from providerPricing rather than as vendor prices.
        const slash = key.indexOf("/");
        if (options.standalonePricing && slash > 0 && !gateways.has(key.slice(0, slash))) {
          const upstream = options.standalonePricing.upstream.get(key);
          if (!upstream) {
            options.standalonePricing.upstream.set(key, { source: source.id, pricing });
          } else if (upstream.source !== source.id) {
            upstream.alternatives = [
              ...(upstream.alternatives ?? []),
              { source: source.id, pricing },
            ];
          }
        }
      }
    }
    for (const aliases of source.aliases) {
      if (aliases.some((key) => coveredKeys.has(key))) {
        for (const key of aliases) {
          coveredKeys.add(key);
        }
      }
    }
  }
  for (const key of coveredKeys) {
    hosted.delete(key);
    // Catalog rows own these keys; direct lookups must not revive an unknown row's price.
    const upstream = options.standalonePricing?.upstream.get(key);
    if (upstream) {
      upstream.passthroughOnly = true;
    }
  }
  materializePolicyRuntimePricing(
    hosted,
    policies,
    sources,
    metadataOwnedKeys,
    gateways,
    options.standalonePricing?.provider,
  );
  options.bundle.pricing = Object.fromEntries(
    [...hosted.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, pricing]) => [key, compactPricing(pricing)]),
  );
  return { modelsEnriched: enriched, pricingEntries: hosted.size };
}

function resolveSourceCommit(rootDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

export async function runPublishModelCatalog(
  options: {
    args?: string[];
    fetchImpl?: typeof fetch;
    now?: () => number;
    rootDir?: string;
    sourceCommit?: string;
  } = {},
) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const args = parsePublishModelCatalogArgs(options.args ?? process.argv.slice(2));
  if (
    args.out &&
    args.outV2 &&
    path.resolve(rootDir, args.out) === path.resolve(rootDir, args.outV2)
  ) {
    throw new Error("--out and --out-v2 must name different files");
  }
  const outputs = [args.out, args.outV2, args.outV3]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(rootDir, value));
  if (new Set(outputs).size !== outputs.length) {
    throw new Error("catalog output paths must be distinct");
  }
  const generatedAt = (options.now ?? Date.now)();
  const sourceCommit = options.sourceCommit ?? resolveSourceCommit(rootDir);
  const manifests = readModelCatalogManifests({ rootDir });
  let bundle = await assembleModelCatalogBundle({ manifests, generatedAt, sourceCommit });
  const pricingSelections = new WeakMap<ModelCatalogModel, PricingSelection>();
  // Capture seed ownership before hydration/enrichment can replace its cost.
  for (const provider of Object.values(bundle.providers)) {
    for (const model of provider.models) {
      if (model.cost && hasKnownPricing(model.cost)) {
        pricingSelections.set(model, { status: "known", source: "manifest" });
      }
    }
  }
  const loadSource = createModelCatalogSourceLoader(options.fetchImpl);
  const hydrationResult = await hydrateModelCatalogFromModelsDev({ bundle, manifests, loadSource });
  const standalonePricing: StandalonePricing = { upstream: new Map(), provider: new Map() };
  const pricingResult = args.pricing
    ? await enrichModelCatalogPricing({
        bundle,
        manifests,
        loadSource,
        pricingSelections,
        standalonePricing,
      })
    : { modelsEnriched: 0, pricingEntries: 0 };
  // Validate after all enrichment so metadata-only and dry-run output obey the
  // same client contract as priced catalogs.
  const validateBundle = await loadClientBundleValidator();
  // Project while selection facts still refer to the assembled model objects.
  const bundleV2 = args.outV2
    ? await assembleModelCatalogBundleV2(bundle, pricingSelections, standalonePricing)
    : undefined;
  const bundleV3 = args.outV3
    ? await assembleModelCatalogBundleV3(bundle, pricingSelections, standalonePricing)
    : undefined;
  bundle = validateBundle(projectLegacyModelCatalogBundle(bundle, pricingSelections));
  const summary = summarizeModelCatalogBundle(bundle);
  // Typed rows cannot mask a truncated legacy chat catalog during wire projection.
  if (
    summary.models < MODEL_CATALOG_MIN_MODELS ||
    !bundle.providers.anthropic ||
    !bundle.providers.openai
  ) {
    throw new Error(
      `legacy catalog must retain anthropic/openai and at least ${MODEL_CATALOG_MIN_MODELS} chat models`,
    );
  }
  const serialized = serializeModelCatalogBundle(bundle);
  const bundleBytes = Buffer.byteLength(serialized);
  const serializedV2 = bundleV2 ? serializeModelCatalogBundleV2(bundleV2) : undefined;
  const bundleV2Bytes = serializedV2 ? Buffer.byteLength(serializedV2) : 0;
  const serializedV3 = bundleV3 ? serializeModelCatalogBundleV2(bundleV3) : undefined;
  const bundleV3Bytes = serializedV3 ? Buffer.byteLength(serializedV3) : 0;
  if (bundleV3Bytes > CLIENT_BUNDLE_LIMIT_BYTES) {
    throw new Error("catalog v3 bundle exceeds client limit");
  }
  if (bundleBytes > BUNDLE_SIZE_WARNING_BYTES) {
    process.stderr.write(
      `[${SCRIPT_LABEL}] warning: bundle size ${bundleBytes} bytes exceeds ${BUNDLE_SIZE_WARNING_BYTES} bytes\n`,
    );
  }
  if (bundleBytes > CLIENT_BUNDLE_LIMIT_BYTES) {
    throw new Error(
      `catalog bundle ${bundleBytes} bytes exceeds client limit ${CLIENT_BUNDLE_LIMIT_BYTES} bytes`,
    );
  }
  if (bundleV2Bytes > CLIENT_BUNDLE_LIMIT_BYTES) {
    throw new Error(
      `catalog v2 bundle ${bundleV2Bytes} bytes exceeds client limit ${CLIENT_BUNDLE_LIMIT_BYTES} bytes`,
    );
  }
  const hydrationSummary = Object.entries(hydrationResult)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([providerId, { added, filled, skipped }]) =>
        `[${SCRIPT_LABEL}] models.dev provider=${providerId} added=${added} filled=${filled} skipped=${skipped}\n`,
    )
    .join("");
  const stats = `schemaVersion=1 providers=${summary.providers} models=${summary.models} costModels=${summary.costModels} pricingEnriched=${pricingResult.modelsEnriched} pricingEntries=${pricingResult.pricingEntries} bundleBytes=${bundleBytes} generatedAt=${bundle.generatedAt} minVersion=${bundle.minVersion} sourceCommit=${bundle.sourceCommit}`;
  if (args.dryRun) {
    process.stdout.write(`[${SCRIPT_LABEL}] dry-run ${stats}\n${hydrationSummary}`);
    return { bundle, summary, pricingEnriched: pricingResult.modelsEnriched, wrote: false };
  }
  if (!args.out) {
    throw new Error("output path is required outside dry-run mode");
  }
  const outputFile = path.resolve(rootDir, args.out);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, serialized);
  if (args.outV2 && serializedV2) {
    const outputV2File = path.resolve(rootDir, args.outV2);
    fs.mkdirSync(path.dirname(outputV2File), { recursive: true });
    fs.writeFileSync(outputV2File, serializedV2);
    process.stdout.write(
      `[${SCRIPT_LABEL}] published schemaVersion=2 models=${summary.models} bundleBytes=${bundleV2Bytes} out=${args.outV2}\n`,
    );
  }
  if (args.outV3 && serializedV3) {
    const output = path.resolve(rootDir, args.outV3);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serializedV3);
    process.stdout.write(
      `[${SCRIPT_LABEL}] published schemaVersion=3 models=${bundleV3?.models.length} bundleBytes=${bundleV3Bytes} out=${args.outV3}\n`,
    );
  }
  process.stdout.write(`[${SCRIPT_LABEL}] published ${stats} out=${args.out}\n${hydrationSummary}`);
  return { bundle, summary, pricingEnriched: pricingResult.modelsEnriched, wrote: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runPublishModelCatalog();
  } catch (error) {
    const errorExitCode =
      error && typeof error === "object" && "exitCode" in error ? error.exitCode : undefined;
    const exitCode =
      typeof errorExitCode === "number" && Number.isInteger(errorExitCode) ? errorExitCode : 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`[${SCRIPT_LABEL}] FAILED (exit ${exitCode})\n`);
    process.exitCode = exitCode;
  }
}
