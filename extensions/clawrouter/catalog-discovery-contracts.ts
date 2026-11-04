import { asOptionalRecord, asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawRouterCapabilityOffer } from "./capability-offers.js";

// These are published operations, not provider-name or response-shape guesses.
const CATALOG_DISCOVERY_CONTRACTS = {
  cerebras: { endpoint: "public_models", format: "cerebras.public_catalog", manifestOnly: true },
  nvidia: { endpoint: "public_models", format: "nvidia.public_catalog", manifestOnly: true },
  chutes: { endpoint: "models_list", format: "chutes.models" },
  venice: { endpoint: "models_list", format: "venice.models" },
  baseten: { endpoint: "models_list", format: "baseten.models" },
  arcee: { endpoint: "models_list", format: "arcee.models" },
  novita: { endpoint: "models_list", format: "novita.models" },
  featherless: { endpoint: "catalog", format: "featherless.catalog", manifestOnly: true },
  deepinfra: { endpoint: "models_list", format: "openai.models" },
  bifrost: { endpoint: "models_list", format: "openai.models" },
  litellm: { endpoint: "models_list", format: "openai.models" },
  requesty: { endpoint: "models_managed", format: "requesty.models_managed" },
} as const;

export type CatalogDiscoveryProvider = keyof typeof CATALOG_DISCOVERY_CONTRACTS;
export type CatalogDiscoveryFact = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  // Upstream observations do not establish the selected router's invoice or tariff.
  observations: Record<string, unknown>;
};

function invalid(): never {
  throw new Error("ClawRouter model discovery returned an invalid or incomplete catalog");
}

export function catalogDiscoveryProvider(id: string): CatalogDiscoveryProvider | undefined {
  return Object.keys(CATALOG_DISCOVERY_CONTRACTS).find(
    (key): key is CatalogDiscoveryProvider => key === id,
  );
}

export function selectCatalogDiscoveryOffer(
  provider: CatalogDiscoveryProvider,
  offers: readonly ClawRouterCapabilityOffer[],
): ClawRouterCapabilityOffer | undefined {
  const contract = CATALOG_DISCOVERY_CONTRACTS[provider];
  const eligible = offers.filter(
    (offer) =>
      offer.providerId === provider &&
      offer.endpoint === contract.endpoint &&
      offer.requestFormat === contract.format &&
      offer.responseFormat === contract.format &&
      offer.path === (provider === "requesty" ? "/models/managed" : "/models") &&
      offer.methods.length === 1 &&
      offer.methods[0] === "GET" &&
      offer.model === undefined &&
      (offer.routeKind === "manifest" ||
        (!("manifestOnly" in contract) && offer.routeKind === "native")),
  );
  // Equivalent operations use one declared route; discovery never tries a second route on failure.
  return eligible.find((offer) => offer.routeKind === "manifest") ?? eligible[0];
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length <= 128 &&
    value.every((entry): entry is string => typeof entry === "string" && entry.length <= 256)
    ? value
    : undefined;
}

function input(value: unknown): Array<"text" | "image"> | undefined {
  const values = strings(value);
  return values
    ? values.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : undefined;
}

function prices(
  value: unknown,
  keys: readonly string[],
): Record<string, number | string> | undefined {
  const row = asOptionalRecord(value),
    result: Record<string, number | string> = {};
  for (const key of keys) {
    const price = row?.[key];
    if (
      (typeof price === "number" && Number.isFinite(price) && price >= 0) ||
      (typeof price === "string" &&
        price.length <= 128 &&
        /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(price) &&
        Number.isFinite(Number(price)))
    ) {
      result[key] = price;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function venicePrices(value: unknown): Record<string, unknown> | undefined {
  const row = asOptionalRecord(value);
  if (!row) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const key of ["input", "output", "cache_input", "cache_write"]) {
    const rate = prices(row[key], ["usd", "diem"]);
    if (rate) {
      result[key] = rate;
    }
  }
  const extended = asOptionalRecord(row.extended);
  if (extended) {
    const threshold = asPositiveSafeInteger(extended.context_token_threshold);
    if (!threshold) {
      return undefined;
    }
    result.extended = {
      ...venicePrices({ ...extended, extended: undefined }),
      context_token_threshold: threshold,
    };
  }
  return Object.keys(result).length ? result : undefined;
}

function readFacts(
  provider: CatalogDiscoveryProvider,
  row: Record<string, unknown>,
  id: string,
): CatalogDiscoveryFact | undefined {
  const fact: CatalogDiscoveryFact = { id, observations: {} };
  if (typeof row.name === "string" && row.name.length <= 512) {
    fact.name = row.name;
  }
  const observed = fact.observations;
  switch (provider) {
    case "cerebras": {
      fact.contextWindow = asPositiveSafeInteger(row.contextWindow);
      fact.maxTokens = asPositiveSafeInteger(row.maxOutputTokens);
      if (!fact.contextWindow || !fact.maxTokens) {
        invalid();
      }
      fact.reasoning = boolean(row.reasoning);
      if (typeof row.vision === "boolean") {
        fact.input = row.vision ? ["text", "image"] : ["text"];
      }
      const pricing = asOptionalRecord(row.pricing);
      if (pricing?.currency === "USD") {
        observed.pricing = {
          ...prices(pricing, ["inputPerToken", "outputPerToken"]),
          currency: "USD",
          denominator: "token",
        };
      }
      observed.tools = boolean(row.tools);
      observed.preview = boolean(row.preview);
      break;
    }
    case "nvidia":
      fact.contextWindow = asPositiveSafeInteger(row.contextWindow);
      if (!fact.contextWindow) {
        invalid();
      }
      // This is a suggested execution budget, not a model output ceiling.
      observed.outputTokenBudget = asPositiveSafeInteger(row.outputTokenBudget);
      observed.metadataSource =
        row.metadataSource === "frozen" || row.metadataSource === "featured"
          ? row.metadataSource
          : undefined;
      fact.reasoning = boolean(row.reasoning);
      fact.input = input(row.input);
      break;
    case "chutes":
      if (row.object !== "model") {
        invalid();
      }
      fact.contextWindow =
        asPositiveSafeInteger(row.context_length) ?? asPositiveSafeInteger(row.max_model_len);
      fact.maxTokens = asPositiveSafeInteger(row.max_output_length);
      fact.input = input(row.input_modalities);
      observed.supported_features = strings(row.supported_features);
      observed.supported_sampling_parameters = strings(row.supported_sampling_parameters);
      observed.confidential_compute = boolean(row.confidential_compute);
      observed.pricing = prices(row.pricing, ["prompt", "completion", "input_cache_read"]);
      break;
    case "venice": {
      if (row.object !== "model" || row.type !== "text") {
        invalid();
      }
      const spec = asOptionalRecord(row.model_spec);
      if (spec?.offline === true) {
        return undefined;
      }
      fact.contextWindow = asPositiveSafeInteger(spec?.availableContextTokens);
      fact.maxTokens = asPositiveSafeInteger(spec?.maxCompletionTokens);
      const capabilities = asOptionalRecord(spec?.capabilities);
      fact.reasoning = boolean(capabilities?.supportsReasoning);
      if (typeof capabilities?.supportsVision === "boolean") {
        fact.input = capabilities.supportsVision ? ["text", "image"] : ["text"];
      }
      observed.pricing = venicePrices(spec?.pricing);
      observed.privacy =
        spec?.privacy === "private" || spec?.privacy === "anonymized" ? spec.privacy : undefined;
      break;
    }
    case "baseten":
      if (row.object !== undefined && row.object !== "model") {
        invalid();
      }
      if (id.startsWith("decision-models/")) {
        return undefined;
      }
      fact.contextWindow = asPositiveSafeInteger(row.context_length);
      fact.maxTokens = asPositiveSafeInteger(row.max_completion_tokens);
      observed.supported_features = strings(row.supported_features);
      observed.pricing = prices(row.pricing, ["prompt", "completion", "input_cache_read"]);
      break;
    case "arcee":
      if (row.object !== undefined && row.object !== "model") {
        invalid();
      }
      fact.contextWindow = asPositiveSafeInteger(row.context_length);
      fact.maxTokens = asPositiveSafeInteger(row.max_output_length);
      fact.input = input(row.input_modalities);
      if (!fact.contextWindow || !fact.maxTokens || !fact.input) {
        invalid();
      }
      observed.pricing = prices(row.pricing, [
        "prompt",
        "completion",
        "image",
        "request",
        "input_cache_reads",
        "input_cache_writes",
      ]);
      observed.supported_features = strings(row.supported_features);
      break;
    case "novita":
      if (row.object !== "model" || !Number.isSafeInteger(row.created)) {
        invalid();
      }
      fact.contextWindow = asPositiveSafeInteger(row.context_size);
      if (!fact.contextWindow) {
        invalid();
      }
      observed.pricing = prices(row, ["input_token_price_per_m", "output_token_price_per_m"]);
      break;
    case "featherless": {
      if (row.available_on_current_plan === false) {
        return undefined;
      }
      fact.contextWindow = asPositiveSafeInteger(row.context_length);
      fact.maxTokens = asPositiveSafeInteger(row.max_completion_tokens);
      const features = asOptionalRecord(row.features);
      if (typeof features?.image_input === "boolean") {
        fact.input = features.image_input ? ["text", "image"] : ["text"];
      }
      observed.tool_use = boolean(features?.tool_use);
      observed.is_gated = boolean(row.is_gated);
      observed.available_on_current_plan = boolean(row.available_on_current_plan);
      observed.concurrency_cost = asPositiveSafeInteger(row.concurrency_cost);
      observed.pricing = prices(row.pricing, ["prompt", "completion", "image", "request"]);
      break;
    }
    case "requesty":
      if (row.api !== "chat" || id.includes("@")) {
        return undefined;
      }
      fact.contextWindow = asPositiveSafeInteger(row.context_window);
      fact.maxTokens = asPositiveSafeInteger(row.max_output_tokens);
      fact.reasoning = boolean(row.supports_reasoning);
      if (typeof row.supports_vision === "boolean") {
        fact.input = row.supports_vision ? ["text", "image"] : ["text"];
      }
      observed.pricing = prices(row, [
        "input_price",
        "output_price",
        "cached_price",
        "caching_price",
      ]);
      for (const field of ["context_window", "max_output_tokens"] as const) {
        if (row[field] === 0) {
          observed[field] = 0;
        }
      }
      break;
    case "deepinfra":
    case "bifrost":
    case "litellm":
      // The published openai.models contract establishes identity only. In particular,
      // DeepInfra's separate {models, availability} catalog is not this wire format.
      if (row.object !== "model") {
        invalid();
      }
      break;
  }
  fact.observations = Object.fromEntries(
    Object.entries(observed).filter(([, value]) => value !== undefined),
  );
  return fact;
}

export function readCatalogDiscoveryRows(
  provider: CatalogDiscoveryProvider,
  payload: unknown,
): CatalogDiscoveryFact[] {
  const body = asOptionalRecord(payload);
  if (!body) {
    invalid();
  }
  const keyed = provider === "cerebras" || provider === "nvidia" || provider === "featherless";
  const allowed = keyed
    ? ["providerId", "catalog"]
    : provider === "venice"
      ? ["object", "type", "data"]
      : provider === "requesty" || provider === "novita"
        ? ["data"]
        : ["object", "data"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    invalid();
  }
  if (keyed && body.providerId !== provider) {
    invalid();
  }
  if (
    (["chutes", "venice", "deepinfra", "bifrost", "litellm"].includes(provider) &&
      body.object !== "list") ||
    (body.object !== undefined && body.object !== "list") ||
    (provider === "venice" && body.type !== "text")
  ) {
    invalid();
  }
  const rows = keyed ? body.catalog : body.data;
  if (!Array.isArray(rows) || rows.length > (provider === "featherless" ? 5000 : 4096)) {
    invalid();
  }
  const seen = new Set<string>(),
    result: CatalogDiscoveryFact[] = [];
  for (const value of rows) {
    const row = asOptionalRecord(value),
      id = row?.id;
    if (
      !row ||
      typeof id !== "string" ||
      !id ||
      id.length > 512 ||
      /[\s\p{Cc}]/u.test(id) ||
      seen.has(id)
    ) {
      invalid();
    }
    seen.add(id);
    const fact = readFacts(provider, row, id);
    if (fact) {
      result.push(fact);
    }
  }
  return result;
}
