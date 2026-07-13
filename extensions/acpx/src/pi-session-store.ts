import { createReadStream, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionCatalogSession } from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const MAX_DISCOVERY_FILES = 10_000;
const SUMMARY_SCAN_BATCH_SIZE = 100;
const MAX_SUMMARY_CACHE_ENTRIES = 256;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_SUMMARY_LINE_CHARS = 1024 * 1024;
const IO_CONCURRENCY = 8;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

export type PiSessionSummary = SessionCatalogSession & { file: string };

type PiFileCandidate = {
  file: string;
  storeRoot: string;
  mtimeMs: number;
  size: number;
};

type CachedSummary = PiFileCandidate & {
  summary?: PiSessionSummary;
};

// Pi owns session-file mutation. Cache entries are reused only while size and
// mtime match, with a bounded process-local cache across lazy scan batches.
const summaryCache = new Map<string, CachedSummary>();
const threadFileCache = new Map<string, string>();

function threadCacheKey(storeRoot: string, threadId: string): string {
  return `${storeRoot}\0${threadId}`;
}

function forgetCachedSummary(file: string): void {
  const cached = summaryCache.get(file);
  const threadId = cached?.summary?.threadId;
  if (cached && threadId) {
    const key = threadCacheKey(cached.storeRoot, threadId);
    if (threadFileCache.get(key) === file) {
      threadFileCache.delete(key);
    }
  }
  summaryCache.delete(file);
}

function cacheSummary(file: string, value: CachedSummary): void {
  forgetCachedSummary(file);
  summaryCache.set(file, value);
  while (summaryCache.size > MAX_SUMMARY_CACHE_ENTRIES) {
    const oldest = summaryCache.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    forgetCachedSummary(oldest);
  }
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function piHome(env: NodeJS.ProcessEnv): string {
  const configured = process.platform === "win32" ? env.USERPROFILE?.trim() : env.HOME?.trim();
  return configured || os.homedir();
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  const home = piHome(env);
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }
  return path.resolve(value);
}

function settingsSessionDir(file: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isRecord(value) ? optionalString(value.sessionDir, 4_096) : undefined;
  } catch {
    return undefined;
  }
}

function piSessionStore(env: NodeJS.ProcessEnv): { root: string; flat: boolean } {
  const customSessionDir = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (customSessionDir) {
    return { root: expandHome(customSessionDir, env), flat: true };
  }
  const home = piHome(env);
  const agentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? expandHome(env.PI_CODING_AGENT_DIR, env)
    : path.join(home, ".pi", "agent");
  const configuredSessionDir =
    settingsSessionDir(path.join(process.cwd(), ".pi", "settings.json")) ??
    settingsSessionDir(path.join(agentDir, "settings.json"));
  if (configuredSessionDir) {
    return { root: expandHome(configuredSessionDir, env), flat: true };
  }
  return {
    root: path.join(agentDir, "sessions"),
    flat: false,
  };
}

export function piSessionStoreAvailable(env: NodeJS.ProcessEnv): boolean {
  try {
    return statSync(piSessionStore(env).root).isDirectory();
  } catch {
    return false;
  }
}

async function discoverPiSessionFiles(
  env: NodeJS.ProcessEnv,
): Promise<{ root: string; files: string[] }> {
  const store = piSessionStore(env);
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(store.root, { withFileTypes: true });
  } catch {
    return { root: store.root, files: [] };
  }
  if (store.flat) {
    return {
      root: store.root,
      files: entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .slice(0, MAX_DISCOVERY_FILES)
        .map((entry) => path.join(store.root, entry.name)),
    };
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || files.length >= MAX_DISCOVERY_FILES) {
      continue;
    }
    const directory = path.join(store.root, entry.name);
    let children: Array<import("node:fs").Dirent>;
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(".jsonl")) {
        files.push(path.join(directory, child.name));
        if (files.length >= MAX_DISCOVERY_FILES) {
          break;
        }
      }
    }
  }
  return { root: store.root, files };
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function piFileCandidates(env: NodeJS.ProcessEnv): Promise<PiFileCandidate[]> {
  const { root, files } = await discoverPiSessionFiles(env);
  const candidates = await mapConcurrent(files, IO_CONCURRENCY, async (file) => {
    try {
      const stats = await fs.stat(file);
      return stats.isFile()
        ? { file, storeRoot: root, mtimeMs: stats.mtimeMs, size: stats.size }
        : undefined;
    } catch {
      return undefined;
    }
  });
  return candidates
    .filter((candidate): candidate is PiFileCandidate => candidate !== undefined)
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

export function parsePiJsonLines(content: string): Record<string, unknown>[] {
  return content.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) {
      return [];
    }
    try {
      const value = JSON.parse(line) as unknown;
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

async function* boundedJsonLines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8" });
  let buffer = "";
  let discarding = false;
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline >= 0 ? newline : text.length;
      if (!discarding) {
        const piece = text.slice(start, end);
        if (buffer.length + piece.length <= MAX_SUMMARY_LINE_CHARS) {
          buffer += piece;
        } else {
          buffer = "";
          discarding = true;
        }
      }
      if (newline < 0) {
        break;
      }
      if (!discarding) {
        yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      }
      buffer = "";
      discarding = false;
      start = newline + 1;
    }
  }
  if (!discarding && buffer) {
    yield buffer;
  }
}

async function readPiSessionSummary(
  candidate: PiFileCandidate,
): Promise<PiSessionSummary | undefined> {
  const cached = summaryCache.get(candidate.file);
  if (cached?.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) {
    summaryCache.delete(candidate.file);
    summaryCache.set(candidate.file, cached);
    return cached.summary;
  }
  let summary: PiSessionSummary | undefined;
  try {
    let header: Record<string, unknown> | undefined;
    let name: string | undefined;
    let firstMessage: string | undefined;
    for await (const line of boundedJsonLines(candidate.file)) {
      const entry = parsePiJsonLines(line)[0];
      if (!entry) {
        continue;
      }
      if (!header) {
        if (entry.type !== "session") {
          break;
        }
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        // Latest metadata wins, including an explicit empty-name clear.
        name = optionalString(entry.name, 1_000);
      } else if (
        !firstMessage &&
        entry.type === "message" &&
        isRecord(entry.message) &&
        entry.message.role === "user"
      ) {
        firstMessage = optionalString(textFromContent(entry.message.content), 1_000);
      }
    }
    const threadId = header?.type === "session" ? optionalString(header.id, 256) : undefined;
    if (header && threadId && SESSION_ID_PATTERN.test(threadId)) {
      const cwd = optionalString(header.cwd, 4_096);
      const createdAt = timestampMs(header.timestamp);
      summary = {
        file: candidate.file,
        threadId,
        ...(name || firstMessage ? { name: name ?? firstMessage } : {}),
        ...(cwd ? { cwd } : {}),
        status: "stored",
        ...(createdAt !== undefined ? { createdAt } : {}),
        updatedAt: candidate.mtimeMs,
        recencyAt: candidate.mtimeMs,
        source: "pi-cli",
        modelProvider: "pi",
        archived: false,
        canContinue: false,
        canArchive: false,
      };
    }
  } catch {
    summary = undefined;
  }
  if (cached?.summary?.threadId && cached.summary.threadId !== summary?.threadId) {
    threadFileCache.delete(threadCacheKey(cached.storeRoot, cached.summary.threadId));
  }
  cacheSummary(candidate.file, { ...candidate, summary });
  if (summary) {
    threadFileCache.set(threadCacheKey(candidate.storeRoot, summary.threadId), candidate.file);
  }
  return summary;
}

function summaryMatches(summary: PiSessionSummary, needle?: string): boolean {
  if (!needle) {
    return true;
  }
  return [summary.threadId, summary.name, summary.cwd].some((field) =>
    field?.toLocaleLowerCase().includes(needle),
  );
}

export async function listPiSummaryPage(
  env: NodeJS.ProcessEnv,
  params: { offset: number; limit: number; searchTerm?: string },
): Promise<{ summaries: PiSessionSummary[]; hasMore: boolean }> {
  const candidates = await piFileCandidates(env);
  const activeFiles = new Set(candidates.map((candidate) => candidate.file));
  for (const file of summaryCache.keys()) {
    if (!activeFiles.has(file)) {
      forgetCachedSummary(file);
    }
  }
  const target = params.offset + params.limit + 1;
  const matches: PiSessionSummary[] = [];
  const needle = params.searchTerm?.toLocaleLowerCase();
  for (
    let index = 0;
    index < candidates.length && matches.length < target;
    index += SUMMARY_SCAN_BATCH_SIZE
  ) {
    const batch = candidates.slice(index, index + SUMMARY_SCAN_BATCH_SIZE);
    const summaries = await mapConcurrent(batch, IO_CONCURRENCY, readPiSessionSummary);
    for (const summary of summaries) {
      if (summary && summaryMatches(summary, needle)) {
        matches.push(summary);
        if (matches.length >= target) {
          break;
        }
      }
    }
  }
  return {
    summaries: matches.slice(params.offset, params.offset + params.limit),
    hasMore: matches.length > params.offset + params.limit,
  };
}

async function findPiSummary(
  threadId: string,
  env: NodeJS.ProcessEnv,
): Promise<PiSessionSummary | undefined> {
  const candidates = await piFileCandidates(env);
  for (let index = 0; index < candidates.length; index += SUMMARY_SCAN_BATCH_SIZE) {
    const summaries = await mapConcurrent(
      candidates.slice(index, index + SUMMARY_SCAN_BATCH_SIZE),
      IO_CONCURRENCY,
      readPiSessionSummary,
    );
    const match = summaries.find((summary) => summary?.threadId === threadId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export async function readPiSessionById(
  threadId: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>[]> {
  const cacheKey = threadCacheKey(piSessionStore(env).root, threadId);
  let file = threadFileCache.get(cacheKey);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!file) {
      file = (await findPiSummary(threadId, env))?.file;
    }
    if (!file) {
      throw new Error("Pi session was not found");
    }
    try {
      const stats = await fs.stat(file);
      if (!stats.isFile()) {
        throw new Error("Pi session is not a file");
      }
      if (stats.size > MAX_SESSION_BYTES) {
        throw new RangeError("Pi session exceeds the 32 MiB read safety limit");
      }
      const entries = parsePiJsonLines(await fs.readFile(file, "utf8"));
      if (entries[0]?.type === "session" && entries[0].id === threadId) {
        return entries;
      }
    } catch (error) {
      if (error instanceof RangeError) {
        throw error;
      }
      if (attempt > 0) {
        throw new Error("Pi session is unavailable", { cause: error });
      }
    }
    // The cached path can disappear when Pi replaces or prunes a session file.
    threadFileCache.delete(cacheKey);
    file = undefined;
  }
  throw new Error("Pi session changed during read");
}
