import fs from "node:fs/promises";
import path from "node:path";
import { parseDateFirstTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { SessionCatalogPullRequestSummary } from "openclaw/plugin-sdk/session-catalog";
import {
  asPositiveSafeInteger as pullRequestNumber,
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { containsAsciiControlCharacter } from "openclaw/plugin-sdk/string-normalization-runtime";
import {
  childDirectories,
  createCatalogJsonReader,
  desktopSessionsDir,
  setBoundedCache,
} from "./session-catalog-scan.js";
import {
  createDirtyDirectoryWatch,
  type DirtyDirectoryWatch,
} from "./session-catalog-tree-watch.js";

const groupCache = new Map<string, { signature: string; assignments: Map<string, string> }>();

const LEVELDB_FOOTER_BYTES = 48;
const LEVELDB_BLOCK_TRAILER_BYTES = 5;
const MAX_LEVELDB_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LEVELDB_FILES = 256;
const MAX_LEVELDB_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SNAPPY_BLOCK_BYTES = 16 * 1024 * 1024;

type ParsedGroups = {
  groups: Map<string, string>;
  assignments: Map<string, string>;
};

type LevelDbValue = {
  sequence: bigint;
  value: Uint8Array;
};

// Desktop spreads group state across more than one Local Storage key, and the key
// names are private to it. Select by record shape instead of key name so a rename
// degrades to "no groups" rather than silently wrong ones, and so only matching
// values are retained in memory. Accepted tradeoff: a deletion tombstone carries no
// records, so clearing Desktop's site data can leave stale labels until compaction.
const GROUP_RECORD_MARKER = /"code:local_[a-f0-9-]+":"cg-|"id":"cg-[a-f0-9-]+","name":"/i;

const LEVELDB_VALUE_KIND = 1;
const EMPTY_VALUE = new Uint8Array();

/**
 * Chromium stores a Local Storage value as UTF-16 whenever it holds a character that
 * Latin-1 cannot represent, so ASCII JSON arrives with interleaved NUL bytes. Dropping
 * them yields one scannable form for both encodings; without this a single emoji in any
 * group name hides every record in that value.
 */
function localStorageText(value: Uint8Array): string {
  return Buffer.from(value).toString("latin1").replaceAll("\0", "");
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[cursor];
    if (byte === undefined) {
      throw new Error("unexpected end of LevelDB varint");
    }
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return [value, cursor];
    }
    shift += 7;
  }
  throw new Error("invalid LevelDB varint");
}

function decodeSnappy(compressed: Uint8Array): Uint8Array {
  let offset = 0;
  const [expectedLength, afterLength] = readVarint(compressed, offset);
  offset = afterLength;
  if (expectedLength > MAX_SNAPPY_BLOCK_BYTES) {
    throw new Error("Claude Desktop LevelDB block is too large");
  }
  const output = new Uint8Array(expectedLength);
  let written = 0;
  while (offset < compressed.length) {
    const tag = compressed[offset];
    if (tag === undefined) {
      throw new Error("unexpected end of Snappy block");
    }
    offset += 1;
    const kind = tag & 0x03;
    if (kind === 0) {
      let length = tag >>> 2;
      if (length < 60) {
        length += 1;
      } else {
        const count = length - 59;
        if (offset + count > compressed.length) {
          throw new Error("invalid Snappy literal length");
        }
        length = 1;
        for (let index = 0; index < count; index += 1) {
          length += (compressed[offset + index] ?? 0) * 2 ** (8 * index);
        }
        offset += count;
      }
      if (offset + length > compressed.length || written + length > output.length) {
        throw new Error("invalid Snappy literal");
      }
      output.set(compressed.subarray(offset, offset + length), written);
      offset += length;
      written += length;
      continue;
    }
    let length: number;
    let copyOffset: number;
    if (kind === 1) {
      length = ((tag >>> 2) & 0x07) + 4;
      copyOffset = ((tag >>> 5) << 8) | (compressed[offset] ?? 0);
      offset += 1;
    } else if (kind === 2) {
      length = (tag >>> 2) + 1;
      copyOffset = (compressed[offset] ?? 0) | ((compressed[offset + 1] ?? 0) << 8);
      offset += 2;
    } else {
      length = (tag >>> 2) + 1;
      copyOffset =
        (compressed[offset] ?? 0) |
        ((compressed[offset + 1] ?? 0) << 8) |
        ((compressed[offset + 2] ?? 0) << 16) |
        ((compressed[offset + 3] ?? 0) << 24);
      offset += 4;
    }
    if (copyOffset <= 0 || copyOffset > written || written + length > output.length) {
      throw new Error("invalid Snappy copy offset");
    }
    for (let index = 0; index < length; index += 1) {
      output[written] = output[written - copyOffset] ?? 0;
      written += 1;
    }
  }
  if (written !== output.length) {
    throw new Error("incomplete Snappy block");
  }
  return output;
}

function readBlock(file: Uint8Array, offset: number, size: number): Uint8Array {
  const trailerOffset = offset + size;
  if (offset < 0 || size < 0 || trailerOffset + LEVELDB_BLOCK_TRAILER_BYTES > file.length) {
    throw new Error("invalid LevelDB block handle");
  }
  const block = file.subarray(offset, trailerOffset);
  switch (file[trailerOffset]) {
    case 0:
      return block;
    case 1:
      return decodeSnappy(block);
    default:
      throw new Error("unsupported LevelDB compression");
  }
}

function forEachLevelDbEntry(
  block: Uint8Array,
  visit: (key: Uint8Array, value: Uint8Array) => void,
): void {
  if (block.length < 4) {
    throw new Error("invalid LevelDB block");
  }
  const restartCount = new DataView(block.buffer, block.byteOffset + block.length - 4, 4).getUint32(
    0,
    true,
  );
  const entriesEnd = block.length - 4 - restartCount * 4;
  if (entriesEnd < 0) {
    throw new Error("invalid LevelDB restart array");
  }
  let offset = 0;
  let previousKey = new Uint8Array();
  while (offset < entriesEnd) {
    const [shared, afterShared] = readVarint(block, offset);
    const [unshared, afterUnshared] = readVarint(block, afterShared);
    const [valueLength, afterValueLength] = readVarint(block, afterUnshared);
    const keyEnd = afterValueLength + unshared;
    const valueEnd = keyEnd + valueLength;
    if (shared > previousKey.length || valueEnd > entriesEnd) {
      throw new Error("invalid LevelDB entry");
    }
    const key = new Uint8Array(shared + unshared);
    key.set(previousKey.subarray(0, shared));
    key.set(block.subarray(afterValueLength, keyEnd), shared);
    visit(key, block.subarray(keyEnd, valueEnd));
    previousKey = key;
    offset = valueEnd;
  }
}

function levelDbDataBlocks(file: Uint8Array): Uint8Array[] {
  if (file.length < LEVELDB_FOOTER_BYTES) {
    return [];
  }
  // Footer layout: metaindex handle (offset+size), then index handle (offset+size).
  const footer = file.subarray(file.length - LEVELDB_FOOTER_BYTES);
  const [, afterMetaindexOffset] = readVarint(footer, 0);
  const [, afterMetaindexHandle] = readVarint(footer, afterMetaindexOffset);
  const [indexOffset, afterIndexOffset] = readVarint(footer, afterMetaindexHandle);
  const [indexSize] = readVarint(footer, afterIndexOffset);
  const index = readBlock(file, indexOffset, indexSize);
  const blocks: Uint8Array[] = [];
  forEachLevelDbEntry(index, (_key, handle) => {
    const [blockOffset, afterBlockOffset] = readVarint(handle, 0);
    const [blockSize] = readVarint(handle, afterBlockOffset);
    blocks.push(readBlock(file, blockOffset, blockSize));
  });
  return blocks;
}

function collectLevelDbValues(block: Uint8Array, values: Map<string, LevelDbValue>): void {
  forEachLevelDbEntry(block, (key, value) => {
    if (key.length < 8) {
      throw new Error("invalid LevelDB internal key");
    }
    const userKey = Buffer.from(key.subarray(0, -8)).toString("latin1");
    const kind = key[key.length - 8];
    let sequence = 0n;
    for (let index = 0; index < 7; index += 1) {
      sequence |= BigInt(key[key.length - 7 + index] ?? 0) << BigInt(index * 8);
    }
    const current = values.get(userKey);
    if (current && sequence <= current.sequence) {
      return;
    }
    // Record the newest entry for every key even when it holds no group records, so a
    // deletion or a store whose last group was removed cannot lose to an older value.
    // Only marker-bearing payloads are retained, which keeps this bounded in memory.
    const live = kind === LEVELDB_VALUE_KIND && GROUP_RECORD_MARKER.test(localStorageText(value));
    values.set(userKey, { sequence, value: live ? value : EMPTY_VALUE });
  });
}

function scanGroupRecords(raw: Uint8Array, parsed: ParsedGroups): void {
  const text = localStorageText(raw);
  for (const match of text.matchAll(/"id":"(cg-[a-f0-9-]+)","name":"([^"\\]{1,500})"/gi)) {
    const [, id, name] = match;
    if (id && name && !containsAsciiControlCharacter(name) && !parsed.groups.has(id)) {
      parsed.groups.set(id, name);
    }
  }
  for (const match of text.matchAll(/"code:(local_[a-f0-9-]+)":"(cg-[a-f0-9-]+)"/gi)) {
    const [, sessionId, groupId] = match;
    if (sessionId && groupId && !parsed.assignments.has(sessionId)) {
      parsed.assignments.set(sessionId, groupId);
    }
  }
}

/**
 * Claude Desktop stores Code custom groups in Chromium Local Storage, not beside the session JSON.
 * This reads only labels and local-session assignments; it never mutates Desktop account state.
 */
async function readClaudeDesktopCustomGroups(
  homeDir: string,
  forceRefresh = false,
): Promise<Map<string, string>> {
  const root = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Claude",
    "Local Storage",
    "leveldb",
  );
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .filter((entry) => entry.isFile() && /\.(ldb|log)$/.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(root, entry.name);
        const stat = await fs.stat(filePath).catch(() => undefined);
        return stat && stat.size <= MAX_LEVELDB_FILE_BYTES
          ? { filePath, mtimeMs: stat.mtimeMs, size: stat.size }
          : undefined;
      }),
  );
  const signature = JSON.stringify(files);
  const cached = groupCache.get(root);
  if (!forceRefresh && cached?.signature === signature) {
    setBoundedCache(groupCache, root, cached, 8);
    return cached.assignments;
  }
  const levelDbValues = new Map<string, LevelDbValue>();
  const parsed: ParsedGroups = { groups: new Map(), assignments: new Map() };
  let remainingBytes = MAX_LEVELDB_TOTAL_BYTES;
  let complete = true;
  for (const file of files
    .filter((candidate) => candidate !== undefined)
    .toSorted(
      (left, right) => right.mtimeMs - left.mtimeMs || right.filePath.localeCompare(left.filePath),
    )
    .slice(0, MAX_LEVELDB_FILES)) {
    if (file.size > remainingBytes) {
      continue;
    }
    remainingBytes -= file.size;
    const raw = await fs.readFile(file.filePath).catch(() => undefined);
    if (!raw) {
      complete = false;
      continue;
    }
    if (!file.filePath.endsWith(".ldb")) {
      scanGroupRecords(raw, parsed);
      continue;
    }
    try {
      for (const block of levelDbDataBlocks(raw)) {
        collectLevelDbValues(block, levelDbValues);
      }
    } catch {
      // Chromium can compact while discovery is reading its local store.
      complete = false;
    }
  }
  // The write-ahead log holds writes that have not been flushed into an SSTable yet, so
  // it seeds the result first and wins on conflict. It is scanned raw rather than replayed,
  // so its own internal ordering stays best-effort; SSTables then fill in the rest.
  for (const { value } of levelDbValues.values()) {
    scanGroupRecords(value, parsed);
  }
  const assignments = new Map<string, string>();
  for (const [sessionId, groupId] of parsed.assignments) {
    const group = parsed.groups.get(groupId);
    if (group) {
      assignments.set(sessionId, group);
    }
  }
  if (complete) {
    setBoundedCache(groupCache, root, { signature, assignments }, 8);
  } else {
    groupCache.delete(root);
  }
  return assignments;
}

export const MAX_STRING_LENGTH = 4096;
const log = createSubsystemLogger("anthropic-session-catalog");
const MAX_SESSION_PULL_REQUESTS = 20;
const CLAUDE_DESKTOP_SCAN_TTL_MS = 60_000;

type DesktopSessionMetadata = {
  sessionId?: string;
  cliSessionId: string;
  cwd?: string;
  createdAt?: number;
  lastActivityAt?: number;
  isArchived: boolean;
  title?: string;
  customGroup?: string;
  pullRequest?: SessionCatalogPullRequestSummary;
};

export type DesktopOverlay = {
  active: Map<string, DesktopSessionMetadata>;
  archived: Set<string>;
};

function pullRequestState(value: unknown): SessionCatalogPullRequestSummary["state"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const state = value.trim().toLowerCase();
  return state === "open" || state === "draft" || state === "merged" || state === "closed"
    ? state
    : undefined;
}

// Desktop retains historical PRs in order and marks hidden ones as dismissed;
// the top-level pair identifies the current PR whose state labels the row.
function desktopPullRequestSummary(
  metadata: Record<string, unknown>,
): SessionCatalogPullRequestSummary | undefined {
  const visibleByNumber = new Map<number, SessionCatalogPullRequestSummary["state"] | undefined>();
  const dismissed = new Set<number>();
  if (Array.isArray(metadata.prs)) {
    for (const entry of metadata.prs) {
      if (!isRecord(entry)) {
        continue;
      }
      const number = pullRequestNumber(entry.prNumber);
      if (!number) {
        continue;
      }
      if (entry.dismissed === true) {
        dismissed.add(number);
        visibleByNumber.delete(number);
        continue;
      }
      if (!dismissed.has(number) && !visibleByNumber.has(number)) {
        visibleByNumber.set(number, pullRequestState(entry.state));
      }
    }
  }
  const currentNumber = pullRequestNumber(metadata.prNumber);
  let currentState = currentNumber ? visibleByNumber.get(currentNumber) : undefined;
  if (currentNumber && !dismissed.has(currentNumber)) {
    currentState = pullRequestState(metadata.prState) ?? currentState;
    // Reinsert the current PR at the tail so truncation always retains it.
    visibleByNumber.delete(currentNumber);
    visibleByNumber.set(currentNumber, currentState);
  }
  const visible = [...visibleByNumber].map(([number, state]) => ({ number, state }));
  if (visible.length === 0) {
    return undefined;
  }
  const state = currentState ?? visible.at(-1)?.state;
  if (!state) {
    return undefined;
  }
  return {
    numbers: visible.slice(-MAX_SESSION_PULL_REQUESTS).map((entry) => entry.number),
    state,
  };
}

function compactString(value: unknown, maxLength: number): string | undefined {
  const normalized = readBoundedString(value, maxLength);
  // trim() can leave a short catalog value retaining a large whitespace-padded string.
  return normalized === undefined
    ? undefined
    : Buffer.from(normalized, "utf16le").toString("utf16le");
}

const readDesktopJson = createCatalogJsonReader((raw): DesktopSessionMetadata | undefined => {
  if (!isRecord(raw)) {
    return undefined;
  }
  const cliSessionId = compactString(raw.cliSessionId, 256);
  if (!cliSessionId) {
    return undefined;
  }
  if (raw.isArchived === true) {
    return { cliSessionId, isArchived: true };
  }
  return {
    cliSessionId,
    isArchived: false,
    sessionId: compactString(raw.sessionId, 256),
    title: compactString(raw.title, 500),
    cwd:
      compactString(raw.cwd, MAX_STRING_LENGTH) ?? compactString(raw.originCwd, MAX_STRING_LENGTH),
    createdAt: parseDateFirstTimestampMs(raw.createdAt),
    lastActivityAt: parseDateFirstTimestampMs(raw.lastActivityAt),
    customGroup: compactString(raw.customGroup, 500),
    pullRequest: desktopPullRequestSummary(raw),
  };
});

export function parsePullRequestSummary(
  value: unknown,
): SessionCatalogPullRequestSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.numbers)) {
    throw new Error("Claude node returned an invalid pull request summary");
  }
  const numbers = value.numbers.flatMap((candidate) => {
    const number = pullRequestNumber(candidate);
    return number === undefined ? [] : [number];
  });
  const state = pullRequestState(value.state);
  if (
    numbers.length === 0 ||
    numbers.length !== value.numbers.length ||
    numbers.length > MAX_SESSION_PULL_REQUESTS ||
    new Set(numbers).size !== numbers.length ||
    !state
  ) {
    throw new Error("Claude node returned an invalid pull request summary");
  }
  return { numbers, state };
}

async function readDesktopMetadata(
  homeDir: string,
  forceRefresh?: boolean,
): Promise<DesktopOverlay> {
  const active = new Map<string, DesktopSessionMetadata>();
  const archived = new Set<string>();
  const customGroups = await readClaudeDesktopCustomGroups(homeDir, forceRefresh);
  for (const accountDir of await childDirectories(desktopSessionsDir(homeDir))) {
    for (const workspaceDir of await childDirectories(accountDir)) {
      const entries = await fs.readdir(workspaceDir).catch(() => []);
      for (const name of entries) {
        if (!name.startsWith("local_") || !name.endsWith(".json")) {
          continue;
        }
        const metadata = await readDesktopJson(path.join(workspaceDir, name));
        if (!metadata) {
          continue;
        }
        const { cliSessionId } = metadata;
        if (metadata.isArchived) {
          archived.add(cliSessionId);
          active.delete(cliSessionId);
          continue;
        }
        if (!archived.has(cliSessionId)) {
          const localSessionId = metadata.sessionId;
          const customGroup = localSessionId ? customGroups.get(localSessionId) : undefined;
          active.set(
            cliSessionId,
            customGroup
              ? { ...metadata, customGroup: readBoundedString(customGroup, 500) }
              : metadata,
          );
        }
      }
    }
  }
  return { active, archived };
}

type DesktopOverlayCacheEntry = {
  watch?: DirtyDirectoryWatch;
  refreshedAt: number;
  refreshing: boolean;
  overlay: Promise<DesktopOverlay>;
};
const desktopOverlays = new Map<string, DesktopOverlayCacheEntry>();
export const emptyDesktopOverlay: DesktopOverlay = {
  active: new Map(),
  archived: new Set(),
};

export async function readDesktopOverlay(
  homeDir: string,
  forceRefresh?: boolean,
): Promise<DesktopOverlay> {
  const entry = desktopOverlays.get(homeDir);
  if (entry?.refreshing) {
    if (!forceRefresh) {
      return entry.overlay;
    }
    await entry.overlay;
    return readDesktopOverlay(homeDir, forceRefresh);
  }
  const dirty = entry?.watch?.takeDirty();
  // Groups live in Local Storage outside this watch. Keep the 60s Desktop refresh even
  // with clean session metadata; it must not invalidate the independent CLI scan.
  if (
    !forceRefresh &&
    entry &&
    entry.refreshedAt + CLAUDE_DESKTOP_SCAN_TTL_MS > Date.now() &&
    dirty !== "all" &&
    !(dirty instanceof Set && dirty.size > 0)
  ) {
    setBoundedCache(desktopOverlays, homeDir, entry, 8);
    return entry.overlay;
  }
  const watch = entry?.watch ?? createDirtyDirectoryWatch(desktopSessionsDir(homeDir), 3);
  const current: DesktopOverlayCacheEntry = {
    watch,
    refreshedAt: Date.now(),
    refreshing: true,
    overlay: Promise.resolve(emptyDesktopOverlay),
  };
  current.overlay = (async () => {
    const stat = await fs.stat(desktopSessionsDir(homeDir)).catch(() => undefined);
    if (!stat?.isDirectory()) {
      // An absent Desktop store is rechecked on the 60s overlay TTL, never on each CLI poll.
      await watch.close();
      current.watch = undefined;
      return emptyDesktopOverlay;
    }
    return readDesktopMetadata(homeDir, forceRefresh);
  })().finally(() => {
    current.refreshing = false;
  });
  setBoundedCache(desktopOverlays, homeDir, current, 8, (evicted) => {
    void evicted.watch?.close().catch((error: unknown) => {
      log.warn(`Claude Desktop catalog watcher cleanup failed: ${String(error)}`);
    });
  });
  return current.overlay;
}
