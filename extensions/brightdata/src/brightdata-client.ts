import { markdownToText, truncateText } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  ensureBrightDataZoneExists,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resetEnsuredBrightDataZones,
  resolveCacheTtlMs,
  withTrustedWebToolsEndpoint,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { wrapExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import {
  DEFAULT_BRIGHTDATA_BASE_URL,
  DEFAULT_BRIGHTDATA_UNLOCKER_ZONE,
  resolveBrightDataApiToken,
  resolveBrightDataBaseUrl,
  resolveBrightDataBrowserZone,
  resolveBrightDataPollingTimeoutSeconds,
  resolveBrightDataScrapeTimeoutSeconds,
  resolveBrightDataSearchTimeoutSeconds,
  resolveBrightDataUnlockerZone,
} from "./config.js";

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const SCRAPE_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();

const DEFAULT_SEARCH_COUNT = 5;
const DEFAULT_SCRAPE_MAX_CHARS = 50_000;
const DEFAULT_ERROR_MAX_BYTES = 64_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

const PENDING_WEB_DATA_STATUSES = new Set(["running", "building", "starting"]);

export type BrightDataSearchEngine = "google" | "bing" | "yandex";
export type BrightDataScrapeExtractMode = "markdown" | "text" | "html";

type BrightDataZoneKind = "unlocker" | "browser";

type BrightDataSearchItem = {
  title: string;
  url: string;
  description?: string;
  siteName?: string;
};

type CleanGoogleSearchPayload = {
  organic: Array<{
    link: string;
    title: string;
    description: string;
  }>;
};

export type BrightDataSearchParams = {
  cfg?: OpenClawConfig;
  query: string;
  engine?: BrightDataSearchEngine;
  count?: number;
  cursor?: string;
  geoLocation?: string;
  timeoutSeconds?: number;
};

export type BrightDataScrapeParams = {
  cfg?: OpenClawConfig;
  url: string;
  extractMode: BrightDataScrapeExtractMode;
  maxChars?: number;
  timeoutSeconds?: number;
};

export type BrightDataWebDataParams = {
  cfg?: OpenClawConfig;
  datasetId: string;
  input: Record<string, unknown>;
  fixedValues?: Record<string, unknown>;
  triggerParams?: Record<string, string | number | boolean>;
  toolName?: string;
  timeoutSeconds?: number;
  pollingTimeoutSeconds?: number;
  onPollAttempt?: (params: {
    attempt: number;
    total: number;
    snapshotId: string;
  }) => Promise<void> | void;
};

class BrightDataApiError extends Error {
  status: number;
  detail?: string;
  code?: string;

  constructor(message: string, params: { status: number; detail?: string; code?: string }) {
    super(message);
    this.name = "BrightDataApiError";
    this.status = params.status;
    this.detail = params.detail;
    this.code = params.code;
  }
}

function resolveEndpoint(baseUrl: string, pathname: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed || DEFAULT_BRIGHTDATA_BASE_URL);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return new URL(pathname, DEFAULT_BRIGHTDATA_BASE_URL).toString();
  }
}

function appendQueryParams(
  urlRaw: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(urlRaw);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function resolveSiteName(urlRaw: string): string | undefined {
  try {
    const host = new URL(urlRaw).hostname.replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function normalizeSearchCount(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(10, Math.floor(value)));
  }
  return DEFAULT_SEARCH_COUNT;
}

function normalizePageIndex(cursor: string | undefined): number {
  if (typeof cursor !== "string" || !cursor.trim()) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeGeoLocation(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length === 2 ? trimmed : undefined;
}

export function buildBrightDataSearchUrl(params: {
  query: string;
  engine: BrightDataSearchEngine;
  cursor?: string;
  geoLocation?: string;
}): string {
  const encodedQuery = encodeURIComponent(params.query);
  const page = normalizePageIndex(params.cursor);
  const start = page * 10;
  if (params.engine === "yandex") {
    return `https://yandex.com/search/?text=${encodedQuery}&p=${page}`;
  }
  if (params.engine === "bing") {
    return `https://www.bing.com/search?q=${encodedQuery}&first=${start + 1}`;
  }
  const geoLocation = normalizeGeoLocation(params.geoLocation);
  const geoParam = geoLocation ? `&gl=${geoLocation}` : "";
  return `https://www.google.com/search?q=${encodedQuery}&start=${start}${geoParam}`;
}

async function throwBrightDataApiError(params: {
  response: Response;
  errorLabel: string;
  unlockerZone?: string;
}): Promise<never> {
  const detail = await readResponseText(params.response, { maxBytes: DEFAULT_ERROR_MAX_BYTES });
  const code = params.response.headers.get("x-brd-err-code") ?? undefined;
  if (code === "client_10100" && params.unlockerZone === DEFAULT_BRIGHTDATA_UNLOCKER_ZONE) {
    throw new BrightDataApiError(
      "Bright Data free-tier usage limit reached for the default mcp_unlocker zone. Create a new Web Unlocker zone and configure BRIGHTDATA_UNLOCKER_ZONE or the Bright Data plugin unlocker zone setting before retrying.",
      {
        status: params.response.status,
        detail: detail.text || params.response.statusText,
        code,
      },
    );
  }
  throw new BrightDataApiError(
    `${params.errorLabel} API error (${params.response.status}): ${detail.text || params.response.statusText}`,
    {
      status: params.response.status,
      detail: detail.text || params.response.statusText,
      code,
    },
  );
}

function buildRequestInit(params: {
  method: "GET" | "POST";
  apiToken: string;
  body?: unknown;
  accept?: string;
}): RequestInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.apiToken}`,
  };
  if (params.accept) {
    headers.Accept = params.accept;
  }
  if (params.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return {
    method: params.method,
    headers,
    ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
  };
}

async function requestBrightDataText(params: {
  baseUrl: string;
  pathname: string;
  apiToken: string;
  timeoutSeconds: number;
  errorLabel: string;
  body?: unknown;
  queryParams?: Record<string, string | number | boolean | undefined>;
  unlockerZone?: string;
}): Promise<string> {
  const endpoint = appendQueryParams(
    resolveEndpoint(params.baseUrl, params.pathname),
    params.queryParams,
  );
  return await withTrustedWebToolsEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: buildRequestInit({
        method: params.body === undefined ? "GET" : "POST",
        apiToken: params.apiToken,
        body: params.body,
        accept: "text/plain, text/html, application/json;q=0.8, */*;q=0.5",
      }),
    },
    async ({ response }) => {
      if (!response.ok) {
        return await throwBrightDataApiError({
          response,
          errorLabel: params.errorLabel,
          unlockerZone: params.unlockerZone,
        });
      }
      return await response.text();
    },
  );
}

async function requestBrightDataJson(params: {
  baseUrl: string;
  pathname: string;
  apiToken: string;
  timeoutSeconds: number;
  errorLabel: string;
  body?: unknown;
  queryParams?: Record<string, string | number | boolean | undefined>;
  unlockerZone?: string;
}): Promise<unknown> {
  const endpoint = appendQueryParams(
    resolveEndpoint(params.baseUrl, params.pathname),
    params.queryParams,
  );
  return await withTrustedWebToolsEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: buildRequestInit({
        method: params.body === undefined ? "GET" : "POST",
        apiToken: params.apiToken,
        body: params.body,
        accept: "application/json",
      }),
    },
    async ({ response }) => {
      if (!response.ok) {
        return await throwBrightDataApiError({
          response,
          errorLabel: params.errorLabel,
          unlockerZone: params.unlockerZone,
        });
      }
      return (await response.json()) as unknown;
    },
  );
}

async function ensureConfiguredBrightDataZoneExists(params: {
  cfg?: OpenClawConfig;
  kind: BrightDataZoneKind;
  timeoutSeconds?: number;
}): Promise<boolean> {
  const apiToken = resolveBrightDataApiToken(params.cfg);
  if (!apiToken) {
    return false;
  }
  const baseUrl = resolveBrightDataBaseUrl(params.cfg);
  const zoneName =
    params.kind === "browser"
      ? resolveBrightDataBrowserZone(params.cfg)
      : resolveBrightDataUnlockerZone(params.cfg);
  const timeoutSeconds = resolveBrightDataSearchTimeoutSeconds(params.timeoutSeconds);
  return await ensureBrightDataZoneExists({
    requestEndpoint: withTrustedWebToolsEndpoint,
    apiToken,
    baseUrl,
    zoneName,
    kind: params.kind,
    timeoutSeconds,
  });
}

export async function ensureBrightDataUnlockerZoneExists(
  cfg?: OpenClawConfig,
  timeoutSeconds?: number,
): Promise<boolean> {
  return await ensureConfiguredBrightDataZoneExists({ cfg, kind: "unlocker", timeoutSeconds });
}

export async function ensureBrightDataBrowserZoneExists(
  cfg?: OpenClawConfig,
  timeoutSeconds?: number,
): Promise<boolean> {
  return await ensureConfiguredBrightDataZoneExists({ cfg, kind: "browser", timeoutSeconds });
}

export function cleanGoogleSearchPayload(rawData: unknown): CleanGoogleSearchPayload {
  const data =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : {};
  const organicRaw = Array.isArray(data.organic) ? data.organic : [];
  const organic = organicRaw
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      const link = typeof record.link === "string" ? record.link.trim() : "";
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const description = typeof record.description === "string" ? record.description.trim() : "";
      if (!link || !title) {
        return undefined;
      }
      return { link, title, description };
    })
    .filter((entry): entry is { link: string; title: string; description: string } => !!entry);
  return { organic };
}

function resolveGoogleSearchItems(rawData: unknown): BrightDataSearchItem[] {
  return cleanGoogleSearchPayload(rawData).organic.map((entry) => ({
    title: entry.title,
    url: entry.link,
    description: entry.description || undefined,
    siteName: resolveSiteName(entry.link),
  }));
}

const RESULT_LINK_LINE_RE =
  /^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?(?:\*\*|__)?\[(.+?)\]\((https?:\/\/[^\s)]+)\)(?:\*\*|__)?(?:\s*(?:[-:|]|[–—])\s*(.+))?$/;

function normalizeMarkdownLine(value: string): string {
  return value
    .replace(/^\s*>\s?/, "")
    .replace(/^(?:[-*+]\s+|\d+\.\s+)/, "")
    .trim();
}

function finalizeMarkdownSearchItem(
  item:
    | {
        title: string;
        url: string;
        descriptionLines: string[];
      }
    | undefined,
): BrightDataSearchItem | undefined {
  if (!item) {
    return undefined;
  }
  const description = item.descriptionLines
    .map((line) => normalizeMarkdownLine(line))
    .filter((line) => !!line && line !== item.url && line !== `<${item.url}>`)
    .join(" ")
    .trim();
  return {
    title: item.title,
    url: item.url,
    description: description || undefined,
    siteName: resolveSiteName(item.url),
  };
}

function dedupeSearchItems(items: BrightDataSearchItem[]): BrightDataSearchItem[] {
  const seen = new Set<string>();
  const deduped: BrightDataSearchItem[] = [];
  for (const item of items) {
    const key = `${item.url}\n${item.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

export function resolveMarkdownSearchItems(markdown: string): BrightDataSearchItem[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const items: BrightDataSearchItem[] = [];
  let current:
    | {
        title: string;
        url: string;
        descriptionLines: string[];
      }
    | undefined;

  // Bright Data returns markdown for Bing/Yandex; treat link lines as result boundaries
  // and fold the following text into a single snippet until the next result starts.
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(RESULT_LINK_LINE_RE);
    if (match) {
      const finalized = finalizeMarkdownSearchItem(current);
      if (finalized) {
        items.push(finalized);
      }
      current = {
        title: match[1].trim(),
        url: match[2].trim(),
        descriptionLines: match[3] ? [match[3].trim()] : [],
      };
      continue;
    }
    if (current) {
      current.descriptionLines.push(rawLine);
    }
  }

  const finalized = finalizeMarkdownSearchItem(current);
  if (finalized) {
    items.push(finalized);
  }
  if (items.length > 0) {
    return dedupeSearchItems(items);
  }

  const fallbackMatches = Array.from(markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g));
  const fallbackItems: BrightDataSearchItem[] = [];
  for (const match of fallbackMatches) {
    const title = match[1]?.trim() ?? "";
    const url = match[2]?.trim() ?? "";
    if (!title || !url) {
      continue;
    }
    const siteName = resolveSiteName(url);
    fallbackItems.push(siteName ? { title, url, siteName } : { title, url });
  }
  return dedupeSearchItems(fallbackItems);
}

export function resolveBrightDataSearchItems(params: {
  engine: BrightDataSearchEngine;
  body: string;
}): BrightDataSearchItem[] {
  if (params.engine === "google") {
    try {
      return resolveGoogleSearchItems(JSON.parse(params.body) as unknown);
    } catch {
      return [];
    }
  }
  return resolveMarkdownSearchItems(params.body);
}

function buildSearchPayload(params: {
  query: string;
  engine: BrightDataSearchEngine;
  cursor?: string;
  geoLocation?: string;
  items: BrightDataSearchItem[];
  tookMs: number;
}): Record<string, unknown> {
  const page = normalizePageIndex(params.cursor);
  return {
    query: params.query,
    provider: "brightdata",
    engine: params.engine,
    count: params.items.length,
    tookMs: params.tookMs,
    cursor: String(page),
    nextCursor: String(page + 1),
    ...(params.geoLocation ? { geoLocation: normalizeGeoLocation(params.geoLocation) } : {}),
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "brightdata",
      wrapped: true,
    },
    results: params.items.map((entry) => ({
      title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
      url: entry.url,
      description: entry.description ? wrapWebContent(entry.description, "web_search") : "",
      ...(entry.siteName ? { siteName: entry.siteName } : {}),
    })),
  };
}

export async function runBrightDataSearch(
  params: BrightDataSearchParams,
): Promise<Record<string, unknown>> {
  const apiToken = resolveBrightDataApiToken(params.cfg);
  if (!apiToken) {
    throw new Error(
      "web_search (brightdata) needs a Bright Data API token. Set BRIGHTDATA_API_TOKEN in the Gateway environment, or configure plugins.entries.brightdata.config.webSearch.apiKey.",
    );
  }
  const engine = params.engine ?? "google";
  const count = normalizeSearchCount(params.count);
  const timeoutSeconds = resolveBrightDataSearchTimeoutSeconds(params.timeoutSeconds);
  const baseUrl = resolveBrightDataBaseUrl(params.cfg);
  const unlockerZone = resolveBrightDataUnlockerZone(params.cfg);
  const geoLocation = normalizeGeoLocation(params.geoLocation);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "brightdata-search",
      query: params.query,
      engine,
      count,
      cursor: params.cursor ?? "",
      geoLocation: geoLocation ?? "",
      baseUrl,
      unlockerZone,
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }
  await ensureBrightDataUnlockerZoneExists(params.cfg, timeoutSeconds);

  const requestUrlBase = buildBrightDataSearchUrl({
    query: params.query,
    engine,
    cursor: params.cursor,
    geoLocation,
  });
  const requestUrl =
    engine === "google"
      ? `${requestUrlBase}${requestUrlBase.includes("?") ? "&" : "?"}brd_json=1`
      : requestUrlBase;
  const startedAt = Date.now();
  const body = await requestBrightDataText({
    baseUrl,
    pathname: "/request",
    apiToken,
    timeoutSeconds,
    errorLabel: "Bright Data Search",
    unlockerZone,
    body: {
      url: requestUrl,
      zone: unlockerZone,
      format: "raw",
      ...(engine === "google" ? { data_format: "parsed_light" } : { data_format: "markdown" }),
    },
  });
  const result = buildSearchPayload({
    query: params.query,
    engine,
    cursor: params.cursor,
    geoLocation,
    items: resolveBrightDataSearchItems({ engine, body }).slice(0, count),
    tookMs: Date.now() - startedAt,
  });
  writeCache(
    SEARCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

function normalizeMarkdownContent(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseBrightDataScrapeBody(params: {
  body: string;
  url: string;
  extractMode: BrightDataScrapeExtractMode;
  maxChars: number;
}): Record<string, unknown> {
  const normalizedInput =
    params.extractMode === "html" ? params.body.trim() : normalizeMarkdownContent(params.body);
  if (!normalizedInput) {
    throw new Error("Bright Data scrape returned no content.");
  }
  const rawText =
    params.extractMode === "text" ? markdownToText(normalizedInput).trim() : normalizedInput;
  const truncated = truncateText(rawText, params.maxChars);
  const wrappedText = wrapExternalContent(truncated.text, {
    source: "web_fetch",
    includeWarning: false,
  });
  return {
    url: params.url,
    finalUrl: params.url,
    extractor: "brightdata",
    extractMode: params.extractMode,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
    },
    truncated: truncated.truncated,
    rawLength: rawText.length,
    wrappedLength: wrappedText.length,
    text: wrappedText,
  };
}

export async function runBrightDataScrape(
  params: BrightDataScrapeParams,
): Promise<Record<string, unknown>> {
  const apiToken = resolveBrightDataApiToken(params.cfg);
  if (!apiToken) {
    throw new Error(
      "brightdata_scrape needs a Bright Data API token. Set BRIGHTDATA_API_TOKEN in the Gateway environment, or configure plugins.entries.brightdata.config.webSearch.apiKey.",
    );
  }
  const baseUrl = resolveBrightDataBaseUrl(params.cfg);
  const unlockerZone = resolveBrightDataUnlockerZone(params.cfg);
  const timeoutSeconds = resolveBrightDataScrapeTimeoutSeconds(params.cfg, params.timeoutSeconds);
  const maxChars = normalizePositiveInteger(params.maxChars, DEFAULT_SCRAPE_MAX_CHARS);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "brightdata-scrape",
      url: params.url,
      extractMode: params.extractMode,
      baseUrl,
      unlockerZone,
      maxChars,
    }),
  );
  const cached = readCache(SCRAPE_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }
  await ensureBrightDataUnlockerZoneExists(params.cfg, timeoutSeconds);

  const body = await requestBrightDataText({
    baseUrl,
    pathname: "/request",
    apiToken,
    timeoutSeconds,
    errorLabel: "Bright Data Scrape",
    unlockerZone,
    body: {
      url: params.url,
      zone: unlockerZone,
      format: "raw",
      ...(params.extractMode === "html" ? {} : { data_format: "markdown" }),
    },
  });
  const result = parseBrightDataScrapeBody({
    body,
    url: params.url,
    extractMode: params.extractMode,
    maxChars,
  });
  writeCache(
    SCRAPE_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

function stripNullish(value: unknown): unknown {
  if (value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripNullish(entry)).filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalized = stripNullish(entry);
      if (normalized !== undefined) {
        result[key] = normalized;
      }
    }
    return result;
  }
  return value;
}

function readSnapshotStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" && status.trim() ? status.trim().toLowerCase() : undefined;
}

export function normalizeBrightDataWebDataPayload(params: {
  datasetId: string;
  snapshotId: string;
  payload: unknown;
}): Record<string, unknown> {
  const cleaned = stripNullish(params.payload);
  if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)) {
    const record = { ...(cleaned as Record<string, unknown>) };
    if (record.snapshotId === undefined && record.snapshot_id === undefined) {
      record.snapshotId = params.snapshotId;
    }
    if (record.datasetId === undefined && record.dataset_id === undefined) {
      record.datasetId = params.datasetId;
    }
    return record;
  }
  return {
    datasetId: params.datasetId,
    snapshotId: params.snapshotId,
    data: cleaned,
  };
}

function isRetryablePollingError(error: unknown): boolean {
  return !(error instanceof BrightDataApiError && error.status === 400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBrightDataWebData(
  params: BrightDataWebDataParams,
): Promise<Record<string, unknown>> {
  const apiToken = resolveBrightDataApiToken(params.cfg);
  if (!apiToken) {
    throw new Error(
      "Bright Data web_data tools need a Bright Data API token. Set BRIGHTDATA_API_TOKEN in the Gateway environment, or configure plugins.entries.brightdata.config.webSearch.apiKey.",
    );
  }
  const baseUrl = resolveBrightDataBaseUrl(params.cfg);
  const timeoutSeconds = resolveBrightDataSearchTimeoutSeconds(params.timeoutSeconds);
  const pollingTimeoutSeconds = normalizePositiveInteger(
    params.pollingTimeoutSeconds,
    resolveBrightDataPollingTimeoutSeconds(params.cfg),
  );
  const toolName = params.toolName?.trim() || `brightdata_${params.datasetId}`;
  const input = { ...params.input, ...(params.fixedValues ?? {}) };
  const triggerPayload = await requestBrightDataJson({
    baseUrl,
    pathname: "/datasets/v3/trigger",
    apiToken,
    timeoutSeconds,
    errorLabel: `${toolName} trigger`,
    queryParams: {
      dataset_id: params.datasetId,
      include_errors: true,
      ...(params.triggerParams ?? {}),
    },
    body: [input],
  });

  const snapshotId =
    triggerPayload &&
    typeof triggerPayload === "object" &&
    !Array.isArray(triggerPayload) &&
    typeof (triggerPayload as Record<string, unknown>).snapshot_id === "string"
      ? ((triggerPayload as Record<string, unknown>).snapshot_id as string)
      : "";
  if (!snapshotId) {
    throw new Error("Bright Data dataset trigger returned no snapshot ID.");
  }

  let attempts = 0;
  let lastError: unknown;
  while (attempts < pollingTimeoutSeconds) {
    if (params.onPollAttempt) {
      await params.onPollAttempt({
        attempt: attempts + 1,
        total: pollingTimeoutSeconds,
        snapshotId,
      });
    }
    try {
      const snapshotPayload = await requestBrightDataJson({
        baseUrl,
        pathname: `/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}`,
        apiToken,
        timeoutSeconds,
        errorLabel: `${toolName} snapshot`,
        queryParams: { format: "json" },
      });
      const status = readSnapshotStatus(snapshotPayload);
      if (status && PENDING_WEB_DATA_STATUSES.has(status)) {
        attempts++;
        await sleep(DEFAULT_POLL_INTERVAL_MS);
        continue;
      }
      return normalizeBrightDataWebDataPayload({
        datasetId: params.datasetId,
        snapshotId,
        payload: snapshotPayload,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryablePollingError(error)) {
        throw error;
      }
      attempts++;
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
  }

  if (lastError instanceof Error && lastError.message) {
    throw new Error(
      `Timeout after ${pollingTimeoutSeconds} seconds waiting for Bright Data dataset results: ${lastError.message}`,
    );
  }
  throw new Error(
    `Timeout after ${pollingTimeoutSeconds} seconds waiting for Bright Data dataset results.`,
  );
}

export const __testing = {
  BrightDataApiError,
  buildBrightDataSearchUrl,
  cleanGoogleSearchPayload,
  ensureBrightDataBrowserZoneExists,
  ensureBrightDataUnlockerZoneExists,
  normalizeBrightDataWebDataPayload,
  parseBrightDataScrapeBody,
  resetEnsuredBrightDataZones: () => {
    resetEnsuredBrightDataZones();
  },
  resolveBrightDataSearchItems,
  resolveMarkdownSearchItems,
};
