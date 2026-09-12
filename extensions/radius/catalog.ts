import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asFiniteNumberInRange,
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const RADIUS_BASE_URL = "https://radius.pi.dev/v1";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ModelCost = ModelDefinitionConfig["cost"];
type RadiusModel = Omit<ModelDefinitionConfig, "input" | "contextWindow"> & {
  input: Array<"text" | "image">;
  contextWindow: number;
};
type RadiusCatalog = Omit<ModelProviderConfig, "models"> & { models: RadiusModel[] };

function readRates(value: unknown): ModelCost | undefined {
  const row = asOptionalRecord(value);
  const input = asFiniteNumberInRange(row?.input, { min: 0 });
  const output = asFiniteNumberInRange(row?.output, { min: 0 });
  const cacheRead = asFiniteNumberInRange(row?.cacheRead, { min: 0 });
  const cacheWrite = asFiniteNumberInRange(row?.cacheWrite, { min: 0 });
  return input !== undefined &&
    output !== undefined &&
    cacheRead !== undefined &&
    cacheWrite !== undefined
    ? { input, output, cacheRead, cacheWrite }
    : undefined;
}

function readCost(value: unknown): ModelCost | undefined {
  const rates = readRates(value);
  if (!rates) {
    return undefined;
  }
  const tiers = asOptionalRecord(value)?.tiers;
  if (tiers === undefined) {
    return rates;
  }
  if (!Array.isArray(tiers)) {
    return undefined;
  }
  const thresholds: Array<{ start: number; rates: ModelCost }> = [{ start: 0, rates }];
  for (const tier of tiers) {
    const tierRates = readRates(tier);
    const threshold = asFiniteNumberInRange(asOptionalRecord(tier)?.inputTokensAbove, { min: 0 });
    if (!tierRates || threshold === undefined || !Number.isSafeInteger(threshold + 1)) {
      return undefined;
    }
    // Radius switches only above the threshold; OpenClaw uses half-open ranges.
    thresholds.push({ start: threshold + 1, rates: tierRates });
  }
  thresholds.sort((left, right) => left.start - right.start);
  if (thresholds.some((tier, index) => index > 0 && tier.start === thresholds[index - 1]?.start)) {
    return undefined;
  }
  return {
    ...rates,
    ...(tiers.length > 0
      ? {
          tieredPricing: thresholds.map(
            (tier, index): NonNullable<ModelCost["tieredPricing"]>[number] => {
              const next = thresholds[index + 1];
              const range: NonNullable<ModelCost["tieredPricing"]>[number]["range"] = next
                ? [tier.start, next.start]
                : [tier.start];
              return Object.assign({}, tier.rates, { range });
            },
          ),
        }
      : {}),
  };
}

function readModel(value: unknown): RadiusModel | undefined {
  const row = asOptionalRecord(value);
  const id = normalizeOptionalString(row?.id);
  const name = normalizeOptionalString(row?.name);
  const cost = readCost(row?.cost);
  const contextWindow = asPositiveSafeInteger(row?.contextWindow);
  const maxTokens = asPositiveSafeInteger(row?.maxTokens);
  if (
    !row ||
    !id ||
    !name ||
    !cost ||
    !contextWindow ||
    !maxTokens ||
    row.enabled === false ||
    typeof row.reasoning !== "boolean" ||
    !Array.isArray(row.input) ||
    row.input.length === 0 ||
    row.input.some((input) => input !== "text" && input !== "image")
  ) {
    return undefined;
  }
  const input: RadiusModel["input"] = row.input.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  let thinkingLevelMap: ModelDefinitionConfig["thinkingLevelMap"];
  if (row.thinkingLevelMap !== undefined) {
    const levels = asOptionalRecord(row.thinkingLevelMap);
    if (!levels) {
      return undefined;
    }
    thinkingLevelMap = {};
    for (const level of THINKING_LEVELS) {
      const mapped = levels[level];
      if (mapped !== undefined) {
        if (mapped !== null && typeof mapped !== "string") {
          return undefined;
        }
        thinkingLevelMap[level] = mapped;
      }
    }
  }
  return {
    id,
    name,
    reasoning: row.reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

export async function fetchRadiusCatalog(
  apiKey?: string,
  signal?: AbortSignal,
): Promise<RadiusCatalog> {
  const documents = await fetchLiveProviderModelRows({
    providerId: "radius",
    endpoint: `${RADIUS_BASE_URL}/config`,
    discoveryApiKey: apiKey,
    signal,
    requireHttps: true,
    readRows: (body) => [body],
  });
  const config = asOptionalRecord(documents[0]);
  const baseUrl = normalizeOptionalString(config?.baseUrl);
  if (!baseUrl || !Array.isArray(config?.models)) {
    throw new Error("Invalid Radius catalog: expected baseUrl and models");
  }
  const endpoint = new URL(baseUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Invalid Radius catalog base URL");
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    api: "pi-messages",
    models: config.models
      .map(readModel)
      .filter((model): model is RadiusModel => model !== undefined),
  };
}
