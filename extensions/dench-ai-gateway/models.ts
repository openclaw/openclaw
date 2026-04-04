export const DEFAULT_DENCH_CLOUD_GATEWAY_URL = "https://gateway.merseoriginals.com";
export const DEFAULT_DENCH_CLOUD_MARGIN_PERCENT = 0.35;

export type DenchCloudCatalogCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  marginPercent?: number;
};

export type DenchCloudCatalogModel = {
  id: string;
  stableId: string;
  displayName: string;
  provider: string;
  transportProvider: string;
  api: "openai-completions" | "openai-responses";
  input: Array<"text" | "image">;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  supportsStreaming: boolean;
  supportsImages: boolean;
  supportsResponses: boolean;
  supportsReasoning: boolean;
  cost: DenchCloudCatalogCost;
};

type UnknownRecord = Record<string, unknown>;

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}

function markupCost(value: number): number {
  return roundUsd(value * (1 + DEFAULT_DENCH_CLOUD_MARGIN_PERCENT));
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function readString(input: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(input: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function readBoolean(input: UnknownRecord, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeInputKinds(input: unknown, supportsImages: boolean): Array<"text" | "image"> {
  if (!Array.isArray(input)) {
    return supportsImages ? ["text", "image"] : ["text"];
  }

  const kinds = new Set<"text" | "image">();
  for (const value of input) {
    if (value === "text" || value === "image") {
      kinds.add(value);
    }
  }

  if (!kinds.has("text")) {
    kinds.add("text");
  }
  if (supportsImages) {
    kinds.add("image");
  }
  return [...kinds];
}

export function normalizeDenchGatewayUrl(value: string | undefined): string {
  const raw = (value || DEFAULT_DENCH_CLOUD_GATEWAY_URL).trim();
  const withProtocol = raw.startsWith("http://") || raw.startsWith("https://")
    ? raw
    : `https://${raw}`;
  return withProtocol.replace(/\/+$/, "").replace(/\/v1$/u, "");
}

export function buildDenchGatewayApiBaseUrl(gatewayUrl: string | undefined): string {
  return `${normalizeDenchGatewayUrl(gatewayUrl)}/v1`;
}

export function buildDenchGatewayCatalogUrl(gatewayUrl: string | undefined): string {
  return `${normalizeDenchGatewayUrl(gatewayUrl)}/v1/public/models`;
}

export const RECOMMENDED_DENCH_CLOUD_MODEL_ID = "claude-opus-4.6";

export const FALLBACK_DENCH_CLOUD_MODELS: DenchCloudCatalogModel[] = [
  {
    id: "claude-opus-4.6",
    stableId: "anthropic.claude-opus-4-6-v1",
    displayName: "Claude Opus 4.6",
    provider: "anthropic",
    transportProvider: "bedrock",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 64000,
    supportsStreaming: true,
    supportsImages: true,
    supportsResponses: true,
    supportsReasoning: false,
    cost: {
      input: markupCost(5),
      output: markupCost(25),
      cacheRead: 0,
      cacheWrite: 0,
      marginPercent: DEFAULT_DENCH_CLOUD_MARGIN_PERCENT,
    },
  },
  {
    id: "gpt-5.4",
    stableId: "gpt-5.4",
    displayName: "GPT-5.4",
    provider: "openai",
    transportProvider: "openai",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 128000,
    supportsStreaming: true,
    supportsImages: true,
    supportsResponses: true,
    supportsReasoning: false,
    cost: {
      input: markupCost(2.5),
      output: markupCost(15),
      cacheRead: 0,
      cacheWrite: 0,
      marginPercent: DEFAULT_DENCH_CLOUD_MARGIN_PERCENT,
    },
  },
  {
    id: "claude-sonnet-4.6",
    stableId: "anthropic.claude-sonnet-4-6-v1",
    displayName: "Claude Sonnet 4.6",
    provider: "anthropic",
    transportProvider: "bedrock",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 64000,
    supportsStreaming: true,
    supportsImages: true,
    supportsResponses: true,
    supportsReasoning: false,
    cost: {
      input: markupCost(3),
      output: markupCost(15),
      cacheRead: 0,
      cacheWrite: 0,
      marginPercent: DEFAULT_DENCH_CLOUD_MARGIN_PERCENT,
    },
  },
];

export function cloneFallbackDenchCloudModels(): DenchCloudCatalogModel[] {
  return FALLBACK_DENCH_CLOUD_MODELS.map((model) => ({
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
  }));
}

export function normalizeDenchCloudCatalogModel(input: unknown): DenchCloudCatalogModel | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const publicId = readString(record, "id", "publicId", "public_id");
  const stableId = readString(record, "stableId", "stable_id") || publicId;
  const displayName = readString(record, "name", "displayName", "display_name");
  const provider = readString(record, "provider");
  const transportProvider = readString(record, "transportProvider", "transport_provider");
  if (!publicId || !stableId || !displayName || !isNonEmptyString(provider) || !isNonEmptyString(transportProvider)) {
    return null;
  }

  const supportsImages = readBoolean(record, "supportsImages", "supports_images") ?? false;
  const supportsStreaming = readBoolean(record, "supportsStreaming", "supports_streaming") ?? true;
  const supportsResponses = readBoolean(record, "supportsResponses", "supports_responses") ?? true;
  const supportsReasoning = readBoolean(record, "supportsReasoning", "supports_reasoning")
    ?? readBoolean(record, "reasoning")
    ?? false;
  const contextWindow = readNumber(record, "contextWindow", "context_window") ?? 200000;
  const maxTokens = readNumber(record, "maxTokens", "max_tokens", "maxOutputTokens", "max_output_tokens") ?? 64000;

  const costRecord = asRecord(record.cost) ?? {};
  const inputCost = readNumber(costRecord, "input") ?? 0;
  const outputCost = readNumber(costRecord, "output") ?? 0;
  const cacheRead = readNumber(costRecord, "cacheRead", "cache_read") ?? 0;
  const cacheWrite = readNumber(costRecord, "cacheWrite", "cache_write") ?? 0;
  const marginPercent = readNumber(costRecord, "marginPercent", "margin_percent");

  return {
    id: publicId,
    stableId,
    displayName,
    provider,
    transportProvider,
    api: record.api === "openai-completions" ? "openai-completions" : "openai-responses",
    input: normalizeInputKinds(record.input, supportsImages),
    reasoning: supportsReasoning,
    contextWindow,
    maxTokens,
    supportsStreaming,
    supportsImages,
    supportsResponses,
    supportsReasoning,
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead,
      cacheWrite,
      ...(marginPercent !== undefined ? { marginPercent } : {}),
    },
  };
}

export function normalizeDenchCloudCatalogResponse(payload: unknown): DenchCloudCatalogModel[] {
  const root = asRecord(payload);
  const data = root?.data;
  if (!Array.isArray(data)) {
    return [];
  }

  const models: DenchCloudCatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const normalized = normalizeDenchCloudCatalogModel(entry);
    if (!normalized || seen.has(normalized.stableId)) {
      continue;
    }
    seen.add(normalized.stableId);
    models.push(normalized);
  }
  return models;
}

export function buildDenchCloudProviderModels(models: DenchCloudCatalogModel[]) {
  return models.map((model) => ({
    id: model.stableId,
    name: `${model.displayName} (Dench Cloud)`,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

export function buildDenchCloudAgentModelEntries(models: DenchCloudCatalogModel[]) {
  return Object.fromEntries(
    models.map((model) => [
      `dench-cloud/${model.stableId}`,
      { alias: `${model.displayName} (Dench Cloud)` },
    ]),
  );
}

export function resolveDenchCloudModel(
  models: DenchCloudCatalogModel[],
  requestedId: string | undefined,
): DenchCloudCatalogModel | undefined {
  const normalized = requestedId?.trim();
  if (!normalized) {
    return (
      models.find((model) => model.id === RECOMMENDED_DENCH_CLOUD_MODEL_ID) ||
      models[0]
    );
  }

  return models.find((model) => model.id === normalized || model.stableId === normalized);
}

export function formatDenchCloudModelHint(model: DenchCloudCatalogModel): string {
  const parts: string[] = [model.provider];
  if (model.reasoning) parts.push("reasoning");
  if (model.id === RECOMMENDED_DENCH_CLOUD_MODEL_ID) parts.push("recommended");
  return parts.join(" · ");
}
