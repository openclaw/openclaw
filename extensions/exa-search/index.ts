import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";

export const id = "exa-search";

const DEFAULT_GATEWAY_URL = "https://gateway.merseoriginals.com";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => readTrimmedString(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function resolveGatewayUrl(config: unknown): string {
  const root = asRecord(config);
  const pluginEntries = asRecord(asRecord(root?.plugins)?.entries);
  const gatewayConfig = asRecord(asRecord(pluginEntries?.["dench-ai-gateway"])?.config);
  return (
    readTrimmedString(gatewayConfig?.gatewayUrl) ||
    process.env.DENCH_GATEWAY_URL?.trim() ||
    DEFAULT_GATEWAY_URL
  );
}

function resolveApiKey(config: unknown): string | undefined {
  const root = asRecord(config);
  const providers = asRecord(asRecord(asRecord(root?.models)?.providers));
  const provider = asRecord(providers?.["dench-cloud"]);
  return (
    readTrimmedString(provider?.apiKey) ||
    process.env.DENCH_CLOUD_API_KEY?.trim() ||
    process.env.DENCH_API_KEY?.trim() ||
    undefined
  );
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const SEARCH_TYPES = [
  "auto",
  "neural",
  "fast",
  "deep",
  "deep-reasoning",
  "instant",
] as const;
const SEARCH_CATEGORIES = [
  "company",
  "research paper",
  "news",
  "personal site",
  "financial report",
  "people",
] as const;

const ExaSearchParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Search query." },
    searchType: { type: "string", enum: [...SEARCH_TYPES], description: "Exa search type." },
    category: { type: "string", enum: [...SEARCH_CATEGORIES], description: "Exa search category." },
    numResults: { type: "number", description: "Maximum number of results." },
    includeDomains: { type: "array", items: { type: "string" }, description: "Only search these domains." },
    excludeDomains: { type: "array", items: { type: "string" }, description: "Exclude these domains." },
    startPublishedDate: { type: "string", description: "ISO date lower bound for published date." },
    endPublishedDate: { type: "string", description: "ISO date upper bound for published date." },
    text: { type: "boolean", description: "Include extracted page text." },
    textMaxCharacters: { type: "number", description: "Maximum characters of extracted text." },
    highlights: { type: "boolean", description: "Include highlights." },
    highlightsMaxCharacters: { type: "number", description: "Maximum characters in highlights." },
    summary: { type: "boolean", description: "Include a summary." },
    summaryQuery: { type: "string", description: "Summary query prompt to send upstream." },
  },
  required: ["query"],
};

const ExaContentsParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    urls: { type: "array", items: { type: "string" }, description: "URLs to fetch content for." },
    text: { type: "boolean", description: "Include extracted page text." },
    textMaxCharacters: { type: "number", description: "Maximum characters of extracted text." },
    highlights: { type: "boolean", description: "Include highlights." },
    highlightsMaxCharacters: { type: "number", description: "Maximum characters in highlights." },
    summary: { type: "boolean", description: "Include a summary." },
    summaryQuery: { type: "string", description: "Summary query prompt to send upstream." },
  },
  required: ["urls"],
};

const ExaAnswerParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Question to answer." },
    text: { type: "boolean", description: "Include extra answer text fields." },
  },
  required: ["query"],
};

function buildTextOption(params: Record<string, unknown>) {
  if (typeof params.textMaxCharacters === "number") {
    return { maxCharacters: params.textMaxCharacters };
  }
  if (params.text === true) {
    return true;
  }
  return undefined;
}

function buildHighlightsOption(params: Record<string, unknown>) {
  if (typeof params.highlightsMaxCharacters === "number") {
    return { maxCharacters: params.highlightsMaxCharacters };
  }
  if (params.highlights === true) {
    return true;
  }
  return undefined;
}

function buildSummaryOption(params: Record<string, unknown>) {
  const query = readTrimmedString(params.summaryQuery);
  if (query) {
    return { query };
  }
  if (params.summary === true) {
    return {};
  }
  return undefined;
}

function buildSearchBody(params: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    query: params.query,
  };
  const searchType = readTrimmedString(params.searchType);
  const category = readTrimmedString(params.category);
  const includeDomains = readStringList(params.includeDomains);
  const excludeDomains = readStringList(params.excludeDomains);
  const startPublishedDate = readTrimmedString(params.startPublishedDate);
  const endPublishedDate = readTrimmedString(params.endPublishedDate);
  const text = buildTextOption(params);
  const highlights = buildHighlightsOption(params);
  const summary = buildSummaryOption(params);
  const contents: Record<string, unknown> = {};

  if (searchType) {
    body.type = searchType;
  }
  if (category) {
    body.category = category;
  }
  if (typeof params.numResults === "number") {
    body.numResults = params.numResults;
  }
  if (includeDomains) {
    body.includeDomains = includeDomains;
  }
  if (excludeDomains) {
    body.excludeDomains = excludeDomains;
  }
  if (startPublishedDate) {
    body.startPublishedDate = startPublishedDate;
  }
  if (endPublishedDate) {
    body.endPublishedDate = endPublishedDate;
  }
  if (text !== undefined) {
    contents.text = text;
  }
  if (highlights !== undefined) {
    contents.highlights = highlights;
  }
  if (summary !== undefined) {
    contents.summary = summary;
  }
  if (Object.keys(contents).length > 0) {
    body.contents = contents;
  }

  return body;
}

function buildContentsBody(params: Record<string, unknown>) {
  const urls = readStringList(params.urls);
  const body: Record<string, unknown> = {
    urls: urls ?? [],
  };
  const text = buildTextOption(params);
  const highlights = buildHighlightsOption(params);
  const summary = buildSummaryOption(params);

  if (text !== undefined) {
    body.text = text;
  }
  if (highlights !== undefined) {
    body.highlights = highlights;
  }
  if (summary !== undefined) {
    body.summary = summary;
  }

  return body;
}

async function parseResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

async function postJson(params: {
  gatewayUrl: string;
  apiKey: string;
  path: string;
  body: Record<string, unknown>;
}) {
  const response = await fetch(`${params.gatewayUrl}${params.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(params.body),
  });

  if (!response.ok) {
    const detail = await parseResponse(response).catch(() => "");
    return jsonResult({
      error: `Search request failed (HTTP ${response.status}).`,
      detail: detail || undefined,
    });
  }

  return jsonResult(await parseResponse(response));
}

function createExaSearchTool(gatewayUrl: string, apiKey: string): AnyAgentTool {
  return {
    name: "exa_search",
    label: "Exa Search",
    description:
      "Search the web through Exa via the Dench Cloud gateway, with optional text extraction, highlights, and summary generation.",
    parameters: ExaSearchParameters,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        return await postJson({
          gatewayUrl,
          apiKey,
          path: "/v1/search",
          body: buildSearchBody(params),
        });
      } catch (err) {
        return jsonResult({
          error: "Search request failed.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  } as AnyAgentTool;
}

function createExaContentsTool(gatewayUrl: string, apiKey: string): AnyAgentTool {
  return {
    name: "exa_get_contents",
    label: "Exa Get Contents",
    description:
      "Fetch page contents for one or more URLs through Exa via the Dench Cloud gateway.",
    parameters: ExaContentsParameters,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const urls = readStringList(params.urls);
        if (!urls) {
          return jsonResult({ error: "At least one URL is required." });
        }
        return await postJson({
          gatewayUrl,
          apiKey,
          path: "/v1/search/contents",
          body: buildContentsBody({ ...params, urls }),
        });
      } catch (err) {
        return jsonResult({
          error: "Contents request failed.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  } as AnyAgentTool;
}

function createExaAnswerTool(gatewayUrl: string, apiKey: string): AnyAgentTool {
  return {
    name: "exa_answer",
    label: "Exa Answer",
    description:
      "Ask Exa for a citation-backed answer through the Dench Cloud gateway.",
    parameters: ExaAnswerParameters,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        return await postJson({
          gatewayUrl,
          apiKey,
          path: "/v1/search/answer",
          body: {
            query: params.query,
            ...(params.text === true ? { text: true } : {}),
          },
        });
      } catch (err) {
        return jsonResult({
          error: "Answer request failed.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  } as AnyAgentTool;
}

export default function register(api: OpenClawPluginApi) {
  const rootConfig = asRecord(api.config);
  const pluginEntries = asRecord(asRecord(rootConfig?.plugins)?.entries);
  const pluginConfig = asRecord(asRecord(pluginEntries?.[id])?.config);
  if (pluginConfig?.enabled === false) {
    return;
  }

  const gatewayUrl = resolveGatewayUrl(api.config);
  const apiKey = resolveApiKey(api.config);

  if (!apiKey) {
    api.logger?.info?.(
      "[exa-search] No Dench Cloud API key found; tools will not be registered.",
    );
    return;
  }

  api.registerTool(createExaSearchTool(gatewayUrl, apiKey));
  api.registerTool(createExaContentsTool(gatewayUrl, apiKey));
  api.registerTool(createExaAnswerTool(gatewayUrl, apiKey));
}
