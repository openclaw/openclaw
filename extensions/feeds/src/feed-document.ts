import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const MAX_FEED_DOCUMENT_BYTES = 1024 * 1024;
export const FEED_FETCH_TIMEOUT_MS = 15_000;
export const FEED_READ_IDLE_TIMEOUT_MS = 15_000;

export type FeedSourceConfig = {
  readonly id: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly trust?: "unsigned" | "pinned";
  readonly integrity?: string;
};

export type FeedEntryType = "skill" | "plugin";

export type FeedEntry = {
  readonly type: FeedEntryType;
  readonly id: string;
  readonly version?: string;
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly sourceUrl?: string;
  readonly sha256?: string;
  readonly install?: Record<string, unknown>;
  readonly approval?: Record<string, unknown>;
};

export type FeedDocument = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly generatedAt?: string;
  readonly entries: readonly FeedEntry[];
};

export type LoadedFeedDocument = {
  readonly source: FeedSourceConfig;
  readonly document: FeedDocument;
  readonly sha256: string;
};

export type FeedFetch = (url: string) => Promise<{ readonly ok: boolean; readonly text: string }>;

export type FeedDocumentRuntime = {
  readonly fetch?: FeedFetch;
  readonly readFile?: (path: string) => Promise<Buffer | string>;
};

export async function loadFeedDocument(
  source: FeedSourceConfig,
  runtime: FeedDocumentRuntime = {},
): Promise<LoadedFeedDocument> {
  const raw = await readFeedBytes(source.url, runtime);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (source.trust === "pinned" && source.integrity === undefined) {
    throw new Error(`Feed source ${source.id} requires integrity for pinned trust.`);
  }
  if (source.integrity !== undefined && source.integrity.toLowerCase() !== `sha256:${sha256}`) {
    throw new Error(`Feed source ${source.id} integrity mismatch.`);
  }
  const parsed = parseFeedDocument(JSON.parse(raw.toString("utf8")), source.id);
  return { source, document: parsed, sha256 };
}

export function parseFeedDocument(value: unknown, sourceId = "feed"): FeedDocument {
  if (!isRecord(value)) {
    throw new Error(`Feed source ${sourceId} must contain a JSON object.`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`Feed source ${sourceId} must use schemaVersion 1.`);
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error(`Feed source ${sourceId} must declare a feed id.`);
  }
  if (value.generatedAt !== undefined && typeof value.generatedAt !== "string") {
    throw new Error(`Feed source ${sourceId} generatedAt must be a string when present.`);
  }
  if (!Array.isArray(value.entries)) {
    throw new Error(`Feed source ${sourceId} entries must be an array.`);
  }
  return {
    schemaVersion: 1,
    id: value.id,
    ...(typeof value.generatedAt === "string" ? { generatedAt: value.generatedAt } : {}),
    entries: value.entries.map((entry, index) => parseFeedEntry(entry, sourceId, index)),
  };
}

export function feedEntryMatchesQuery(entry: FeedEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") {
    return true;
  }
  const haystack = [
    entry.type,
    entry.id,
    entry.version,
    entry.name,
    entry.description,
    ...(entry.tags ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  return haystack.includes(normalized);
}

async function readFeedBytes(url: string, runtime: FeedDocumentRuntime): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    const read = runtime.readFile ?? readFile;
    const value = await read(fileURLToPath(parsed));
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  }
  if (parsed.protocol === "https:") {
    const fetcher = runtime.fetch ?? defaultFetch;
    const response = await fetcher(url);
    if (!response.ok) {
      throw new Error(
        `Feed URL ${formatFeedUrlForDiagnostics(url)} did not return a successful response.`,
      );
    }
    return Buffer.from(response.text, "utf8");
  }
  throw new Error(`Unsupported feed URL protocol for ${formatFeedUrlForDiagnostics(url)}.`);
}

function formatFeedUrlForDiagnostics(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value.split(/[?#]/u, 1)[0] ?? value;
  }
}

async function defaultFetch(url: string): Promise<{ readonly ok: boolean; readonly text: string }> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    auditContext: "feeds.feed-document",
    timeoutMs: FEED_FETCH_TIMEOUT_MS,
  });
  try {
    const body = await readResponseWithLimit(response, MAX_FEED_DOCUMENT_BYTES, {
      chunkTimeoutMs: FEED_READ_IDLE_TIMEOUT_MS,
      onIdleTimeout: ({ chunkTimeoutMs }) =>
        new Error(
          "Feed URL " +
            formatFeedUrlForDiagnostics(url) +
            " response stalled for " +
            chunkTimeoutMs +
            "ms.",
        ),
      onOverflow: ({ maxBytes }) =>
        new Error(
          "Feed URL " +
            formatFeedUrlForDiagnostics(url) +
            " response exceeds " +
            maxBytes +
            " bytes.",
        ),
    });
    return { ok: response.ok, text: body.toString("utf8") };
  } finally {
    await release();
  }
}

function parseFeedEntry(value: unknown, sourceId: string, index: number): FeedEntry {
  if (!isRecord(value)) {
    throw new Error(`Feed source ${sourceId} entry ${index} must be an object.`);
  }
  if (value.type !== "skill" && value.type !== "plugin") {
    throw new Error(`Feed source ${sourceId} entry ${index} must be a skill or plugin.`);
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error(`Feed source ${sourceId} entry ${index} must declare an id.`);
  }
  return {
    type: value.type,
    id: value.id,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")
      ? { tags: value.tags }
      : {}),
    ...(typeof value.sourceUrl === "string" ? { sourceUrl: value.sourceUrl } : {}),
    ...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
    ...(isRecord(value.install) ? { install: value.install } : {}),
    ...(isRecord(value.approval) ? { approval: value.approval } : {}),
  };
}
