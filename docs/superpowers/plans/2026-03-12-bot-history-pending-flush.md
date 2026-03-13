# Bot History Pending Flush Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the bot sends proactive cron messages to a chat, persist those messages and flush them into the session transcript on the next inbound message so the LLM has full context.

**Architecture:** A JSON file store (`~/.openclaw/bot-history/pending.json`) buffers bot messages at delivery time. On inbound, matching entries are flushed to the session transcript via the existing `appendAssistantMessageToSessionTranscript` infrastructure.

**Tech Stack:** TypeScript (ESM), Node.js fs, Vitest

**Spec:** `docs/superpowers/specs/2026-03-12-bot-history-pending-flush-design.md`

---

## File Structure

| File                                           | Responsibility                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/auto-reply/reply/bot-history.ts`          | **New** — Pending store (load/save/append/read/remove/compact) + `flushBotHistoryToTranscript` |
| `src/auto-reply/reply/bot-history.test.ts`     | **New** — Unit tests for all store operations and flush logic                                  |
| `src/cron/isolated-agent/delivery-dispatch.ts` | **Modify** — Add recording call inside `deliverViaDirect` closure                              |
| `src/auto-reply/reply/get-reply.ts`            | **Modify** — Add flush call after `initSessionState()` destructuring                           |

---

## Chunk 1: Core Store + Tests

### Task 1: Pending Bot History Store — Types and Load/Save

**Files:**

- Create: `src/auto-reply/reply/bot-history.ts`
- Test: `src/auto-reply/reply/bot-history.test.ts`

- [ ] **Step 1: Write test scaffolding and first failing test (load empty store)**

Create `src/auto-reply/reply/bot-history.test.ts`:

```typescript
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Will be imported once implemented
// import { appendBotHistoryEntry, readBotHistoryEntries, removeBotHistoryEntries, compactBotHistoryStore } from "./bot-history.js";

let fixtureRoot = "";
let caseId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bot-history-"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

function makeStorePath(): string {
  return path.join(fixtureRoot, `case-${caseId++}`, "bot-history", "pending.json");
}

describe("bot-history store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("readBotHistoryEntries returns [] when store does not exist", async () => {
    const storePath = makeStorePath();
    const { readBotHistoryEntries } = await import("./bot-history.js");
    const entries = await readBotHistoryEntries(
      { channel: "telegram", to: "telegram:-100123" },
      { storePath },
    );
    expect(entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/auto-reply/reply/bot-history.test.ts`
Expected: FAIL — module `./bot-history.js` does not exist

- [ ] **Step 3: Create bot-history.ts with types, load/save, and readBotHistoryEntries**

Create `src/auto-reply/reply/bot-history.ts`:

```typescript
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../../utils.js";

// ── Types ──

export type BotHistoryEntry = {
  id: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  text: string;
  timestamp: number;
  source?: string;
};

type BotHistoryStore = {
  version: 1;
  entries: BotHistoryEntry[];
};

// ── Constants ──

const DEFAULT_BOT_HISTORY_DIR = path.join(CONFIG_DIR, "bot-history");
const DEFAULT_STORE_PATH = path.join(DEFAULT_BOT_HISTORY_DIR, "pending.json");
const MAX_ENTRIES = 500;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const COMPACTION_THRESHOLD = 400;

// ── In-memory cache (same pattern as cron store's serializedStoreCache) ──

const serializedStoreCache = new Map<string, string>();

// ── Internal helpers ──

function resolveStorePath(override?: string): string {
  return override ?? DEFAULT_STORE_PATH;
}

async function loadStore(storePath: string): Promise<BotHistoryStore> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const entries = Array.isArray(record.entries) ? (record.entries as BotHistoryEntry[]) : [];
      const store: BotHistoryStore = { version: 1, entries };
      serializedStoreCache.set(storePath, JSON.stringify(store));
      return store;
    }
    return { version: 1, entries: [] };
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      serializedStoreCache.delete(storePath);
      return { version: 1, entries: [] };
    }
    throw err;
  }
}

async function saveStore(storePath: string, store: BotHistoryStore): Promise<void> {
  const storeDir = path.dirname(storePath);
  await fs.promises.mkdir(storeDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(storeDir, 0o700).catch(() => undefined);
  const json = JSON.stringify(store);
  const cached = serializedStoreCache.get(storePath);
  if (cached === json) {
    return;
  }
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.chmod(tmp, 0o600).catch(() => undefined);
  await renameWithRetry(tmp, storePath);
  await fs.promises.chmod(storePath, 0o600).catch(() => undefined);
  serializedStoreCache.set(storePath, json);
}

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      if (code === "EPERM" || code === "EEXIST") {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => {});
        return;
      }
      throw err;
    }
  }
}

// ── Exported functions ──

type StoreOptions = { storePath?: string };

export async function readBotHistoryEntries(
  query: { channel: string; to: string; accountId?: string; threadId?: string },
  opts?: StoreOptions,
): Promise<BotHistoryEntry[]> {
  const storePath = resolveStorePath(opts?.storePath);
  const store = await loadStore(storePath);
  return store.entries.filter(
    (e) =>
      e.channel === query.channel &&
      e.to === query.to &&
      e.accountId === query.accountId &&
      e.threadId === query.threadId,
  );
}

export async function appendBotHistoryEntry(
  entry: Omit<BotHistoryEntry, "id">,
  opts?: StoreOptions,
): Promise<void> {
  const storePath = resolveStorePath(opts?.storePath);
  const store = await loadStore(storePath);

  // Lazy compaction when threshold exceeded
  if (store.entries.length >= COMPACTION_THRESHOLD) {
    compactEntries(store);
  }

  // Enforce max entries — drop oldest if at capacity
  if (store.entries.length >= MAX_ENTRIES) {
    store.entries.sort((a, b) => a.timestamp - b.timestamp);
    store.entries.splice(0, store.entries.length - MAX_ENTRIES + 1);
  }

  store.entries.push({ ...entry, id: randomUUID() });
  await saveStore(storePath, store);
}

export async function removeBotHistoryEntries(ids: string[], opts?: StoreOptions): Promise<void> {
  if (ids.length === 0) return;
  const storePath = resolveStorePath(opts?.storePath);
  const store = await loadStore(storePath);
  const idSet = new Set(ids);
  store.entries = store.entries.filter((e) => !idSet.has(e.id));
  await saveStore(storePath, store);
}

export async function compactBotHistoryStore(opts?: StoreOptions): Promise<number> {
  const storePath = resolveStorePath(opts?.storePath);
  const store = await loadStore(storePath);
  const before = store.entries.length;
  compactEntries(store);
  if (store.entries.length !== before) {
    await saveStore(storePath, store);
  }
  return before - store.entries.length;
}

function compactEntries(store: BotHistoryStore): void {
  const cutoff = Date.now() - TTL_MS;
  store.entries = store.entries.filter((e) => e.timestamp > cutoff);
}

// For tests: reset the in-memory cache
export function _resetBotHistoryCache(): void {
  serializedStoreCache.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/auto-reply/reply/bot-history.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(bot-history): add pending store with load/save/read/append/remove/compact" \
  src/auto-reply/reply/bot-history.ts \
  src/auto-reply/reply/bot-history.test.ts
```

---

### Task 2: Comprehensive Unit Tests for Store Operations

**Files:**

- Modify: `src/auto-reply/reply/bot-history.test.ts`

- [ ] **Step 1: Add tests for append, read with matching, remove, compaction, and max entries**

Expand `src/auto-reply/reply/bot-history.test.ts` — add the following test cases inside the `describe("bot-history store")` block, after the existing test. Each test uses a fresh `storePath` and imports the module with `resetModules` to isolate cache state.

```typescript
it("appendBotHistoryEntry writes and readBotHistoryEntries retrieves", async () => {
  const storePath = makeStorePath();
  const { appendBotHistoryEntry, readBotHistoryEntries, _resetBotHistoryCache } =
    await import("./bot-history.js");
  _resetBotHistoryCache();

  await appendBotHistoryEntry(
    {
      channel: "telegram",
      to: "telegram:-100123",
      text: "hello from cron",
      timestamp: Date.now(),
      source: "cron",
    },
    { storePath },
  );

  const entries = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123" },
    { storePath },
  );
  expect(entries).toHaveLength(1);
  expect(entries[0].text).toBe("hello from cron");
  expect(entries[0].id).toBeTruthy();
  expect(entries[0].source).toBe("cron");
});

it("readBotHistoryEntries filters by channel + to", async () => {
  const storePath = makeStorePath();
  const { appendBotHistoryEntry, readBotHistoryEntries, _resetBotHistoryCache } =
    await import("./bot-history.js");
  _resetBotHistoryCache();

  await appendBotHistoryEntry(
    { channel: "telegram", to: "telegram:-100123", text: "msg1", timestamp: 1000 },
    { storePath },
  );
  await appendBotHistoryEntry(
    { channel: "telegram", to: "telegram:-100999", text: "msg2", timestamp: 2000 },
    { storePath },
  );
  await appendBotHistoryEntry(
    { channel: "discord", to: "discord:456", text: "msg3", timestamp: 3000 },
    { storePath },
  );

  const results = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123" },
    { storePath },
  );
  expect(results).toHaveLength(1);
  expect(results[0].text).toBe("msg1");
});

it("readBotHistoryEntries uses strict equality for accountId and threadId", async () => {
  const storePath = makeStorePath();
  const { appendBotHistoryEntry, readBotHistoryEntries, _resetBotHistoryCache } =
    await import("./bot-history.js");
  _resetBotHistoryCache();

  await appendBotHistoryEntry(
    {
      channel: "telegram",
      to: "telegram:-100123",
      accountId: "acct-A",
      threadId: "42",
      text: "acct-A thread-42",
      timestamp: 1000,
    },
    { storePath },
  );
  await appendBotHistoryEntry(
    {
      channel: "telegram",
      to: "telegram:-100123",
      accountId: "acct-B",
      text: "acct-B no thread",
      timestamp: 2000,
    },
    { storePath },
  );

  // Match acct-A + thread 42
  const matchA = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123", accountId: "acct-A", threadId: "42" },
    { storePath },
  );
  expect(matchA).toHaveLength(1);
  expect(matchA[0].text).toBe("acct-A thread-42");

  // Wrong accountId — no match
  const noMatch = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123", accountId: "acct-C" },
    { storePath },
  );
  expect(noMatch).toHaveLength(0);

  // Both undefined — matches entry with no accountId/threadId? No, acct-B has accountId set.
  const undefinedMatch = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123" },
    { storePath },
  );
  expect(undefinedMatch).toHaveLength(0); // Both entries have accountId set
});

it("removeBotHistoryEntries removes specific entries by id", async () => {
  const storePath = makeStorePath();
  const {
    appendBotHistoryEntry,
    readBotHistoryEntries,
    removeBotHistoryEntries,
    _resetBotHistoryCache,
  } = await import("./bot-history.js");
  _resetBotHistoryCache();

  await appendBotHistoryEntry(
    { channel: "telegram", to: "telegram:-100123", text: "keep", timestamp: 1000 },
    { storePath },
  );
  await appendBotHistoryEntry(
    { channel: "telegram", to: "telegram:-100123", text: "remove", timestamp: 2000 },
    { storePath },
  );

  const all = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123" },
    { storePath },
  );
  expect(all).toHaveLength(2);
  const toRemove = all.find((e) => e.text === "remove")!;

  await removeBotHistoryEntries([toRemove.id], { storePath });

  const remaining = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123" },
    { storePath },
  );
  expect(remaining).toHaveLength(1);
  expect(remaining[0].text).toBe("keep");
});

it("compactBotHistoryStore removes entries older than TTL", async () => {
  const storePath = makeStorePath();
  const {
    appendBotHistoryEntry,
    compactBotHistoryStore,
    readBotHistoryEntries,
    _resetBotHistoryCache,
  } = await import("./bot-history.js");
  _resetBotHistoryCache();

  const now = Date.now();
  const oldTimestamp = now - 25 * 60 * 60 * 1000; // 25 hours ago

  await appendBotHistoryEntry(
    { channel: "telegram", to: "telegram:-100123", text: "old", timestamp: oldTimestamp },
    { storePath },
  );
  await appendBotHistoryEntry(
    { channel: "telegram", to: "telegram:-100123", text: "fresh", timestamp: now },
    { storePath },
  );

  const removed = await compactBotHistoryStore({ storePath });
  expect(removed).toBe(1);

  const remaining = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123" },
    { storePath },
  );
  expect(remaining).toHaveLength(1);
  expect(remaining[0].text).toBe("fresh");
});

it("appendBotHistoryEntry enforces max 500 entries", async () => {
  const storePath = makeStorePath();
  const { appendBotHistoryEntry, _resetBotHistoryCache } = await import("./bot-history.js");
  _resetBotHistoryCache();

  // Write 500 entries
  for (let i = 0; i < 500; i++) {
    await appendBotHistoryEntry(
      { channel: "telegram", to: "telegram:-100123", text: `msg-${i}`, timestamp: 1000 + i },
      { storePath },
    );
  }

  // Write one more — oldest should be evicted
  await appendBotHistoryEntry(
    { channel: "telegram", to: "telegram:-100123", text: "msg-500", timestamp: 2000 },
    { storePath },
  );

  const { readBotHistoryEntries } = await import("./bot-history.js");
  const all = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123" },
    { storePath },
  );
  expect(all.length).toBeLessThanOrEqual(500);
  // The very first entry (msg-0) should have been evicted
  expect(all.find((e) => e.text === "msg-0")).toBeUndefined();
  expect(all.find((e) => e.text === "msg-500")).toBeTruthy();
});

it("store persists to disk and survives cache reset", async () => {
  const storePath = makeStorePath();
  const { appendBotHistoryEntry, readBotHistoryEntries, _resetBotHistoryCache } =
    await import("./bot-history.js");
  _resetBotHistoryCache();

  await appendBotHistoryEntry(
    { channel: "telegram", to: "telegram:-100123", text: "persisted", timestamp: Date.now() },
    { storePath },
  );

  // Reset cache to force re-read from disk
  _resetBotHistoryCache();

  const entries = await readBotHistoryEntries(
    { channel: "telegram", to: "telegram:-100123" },
    { storePath },
  );
  expect(entries).toHaveLength(1);
  expect(entries[0].text).toBe("persisted");
});
```

- [ ] **Step 2: Run all tests to verify they pass**

Run: `pnpm vitest run src/auto-reply/reply/bot-history.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
scripts/committer "test(bot-history): add comprehensive unit tests for store operations" \
  src/auto-reply/reply/bot-history.test.ts
```

---

### Task 3: flushBotHistoryToTranscript Function

**Files:**

- Modify: `src/auto-reply/reply/bot-history.ts`
- Modify: `src/auto-reply/reply/bot-history.test.ts`

- [ ] **Step 1: Write failing test for flushBotHistoryToTranscript**

Add to `src/auto-reply/reply/bot-history.test.ts`:

Add the `vi.mock` call at the **top of the file** (after existing imports, before `let fixtureRoot`). Vitest hoists `vi.mock` calls, so it applies module-wide. This does NOT affect Task 2 store-only tests since they never call `flushBotHistoryToTranscript`.

```typescript
// Add this at the top of the file, after imports:
vi.mock("../../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: vi.fn(),
}));
```

Then add a new `describe` block after the existing `describe("bot-history store")` block:

```typescript
describe("flushBotHistoryToTranscript", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushes matching entries to session transcript and removes them", async () => {
    const storePath = makeStorePath();
    const {
      appendBotHistoryEntry,
      flushBotHistoryToTranscript,
      readBotHistoryEntries,
      _resetBotHistoryCache,
    } = await import("./bot-history.js");
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.js");
    _resetBotHistoryCache();

    const mockAppend = vi.mocked(appendAssistantMessageToSessionTranscript);
    mockAppend.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });

    await appendBotHistoryEntry(
      { channel: "telegram", to: "telegram:-100123", text: "cron msg 1", timestamp: 1000 },
      { storePath },
    );
    await appendBotHistoryEntry(
      { channel: "telegram", to: "telegram:-100123", text: "cron msg 2", timestamp: 2000 },
      { storePath },
    );

    const flushed = await flushBotHistoryToTranscript({
      channel: "telegram",
      to: "telegram:-100123",
      sessionKey: "test-session",
      agentId: "test-agent",
      storePath,
    });

    expect(flushed).toBe(2);
    expect(mockAppend).toHaveBeenCalledTimes(2);
    // Flushed in chronological order
    expect(mockAppend).toHaveBeenNthCalledWith(1, {
      agentId: "test-agent",
      sessionKey: "test-session",
      text: "cron msg 1",
    });
    expect(mockAppend).toHaveBeenNthCalledWith(2, {
      agentId: "test-agent",
      sessionKey: "test-session",
      text: "cron msg 2",
    });

    // Entries should be removed after flush
    const remaining = await readBotHistoryEntries(
      { channel: "telegram", to: "telegram:-100123" },
      { storePath },
    );
    expect(remaining).toHaveLength(0);
  });

  it("returns 0 when no matching entries exist", async () => {
    const storePath = makeStorePath();
    const { flushBotHistoryToTranscript, _resetBotHistoryCache } = await import("./bot-history.js");
    _resetBotHistoryCache();

    const flushed = await flushBotHistoryToTranscript({
      channel: "telegram",
      to: "telegram:-100123",
      sessionKey: "test-session",
      agentId: "test-agent",
      storePath,
    });
    expect(flushed).toBe(0);
  });

  it("keeps entries that fail to flush", async () => {
    const storePath = makeStorePath();
    const {
      appendBotHistoryEntry,
      flushBotHistoryToTranscript,
      readBotHistoryEntries,
      _resetBotHistoryCache,
    } = await import("./bot-history.js");
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.js");
    _resetBotHistoryCache();

    const mockAppend = vi.mocked(appendAssistantMessageToSessionTranscript);
    // First succeeds, second fails
    mockAppend
      .mockResolvedValueOnce({ ok: true, sessionFile: "/tmp/test.jsonl" })
      .mockResolvedValueOnce({ ok: false, reason: "unknown sessionKey" });

    await appendBotHistoryEntry(
      { channel: "telegram", to: "telegram:-100123", text: "will flush", timestamp: 1000 },
      { storePath },
    );
    await appendBotHistoryEntry(
      { channel: "telegram", to: "telegram:-100123", text: "will fail", timestamp: 2000 },
      { storePath },
    );

    const flushed = await flushBotHistoryToTranscript({
      channel: "telegram",
      to: "telegram:-100123",
      sessionKey: "test-session",
      agentId: "test-agent",
      storePath,
    });

    expect(flushed).toBe(1);

    // The failed entry should remain
    const remaining = await readBotHistoryEntries(
      { channel: "telegram", to: "telegram:-100123" },
      { storePath },
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe("will fail");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/auto-reply/reply/bot-history.test.ts`
Expected: FAIL — `flushBotHistoryToTranscript` is not exported

- [ ] **Step 3: Implement flushBotHistoryToTranscript**

Add to the end of `src/auto-reply/reply/bot-history.ts` (before `_resetBotHistoryCache`):

```typescript
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";

export async function flushBotHistoryToTranscript(params: {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  sessionKey: string;
  agentId: string;
  storePath?: string;
}): Promise<number> {
  const entries = await readBotHistoryEntries(
    {
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      threadId: params.threadId,
    },
    { storePath: params.storePath },
  );
  if (entries.length === 0) return 0;

  entries.sort((a, b) => a.timestamp - b.timestamp);

  // Flush each entry individually. Only remove entries that succeed —
  // failed entries stay for the next flush attempt.
  const flushedIds: string[] = [];
  for (const entry of entries) {
    const result = await appendAssistantMessageToSessionTranscript({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      text: entry.text,
    });
    if (result.ok) {
      flushedIds.push(entry.id);
    }
  }

  if (flushedIds.length > 0) {
    await removeBotHistoryEntries(flushedIds, { storePath: params.storePath });
  }
  return flushedIds.length;
}
```

**Important:** Add the `import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js"` line to the **existing import block at the top of `bot-history.ts`** (after the `import { CONFIG_DIR }` line). Do NOT include it inline in the function code block above — it is shown there only for context.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/auto-reply/reply/bot-history.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(bot-history): add flushBotHistoryToTranscript with partial-failure safety" \
  src/auto-reply/reply/bot-history.ts \
  src/auto-reply/reply/bot-history.test.ts
```

---

## Chunk 2: Integration Points

### Task 4: Recording Point in delivery-dispatch.ts

**Files:**

- Modify: `src/cron/isolated-agent/delivery-dispatch.ts:275`

- [ ] **Step 1: Add the recording call inside `deliverViaDirect`**

In `src/cron/isolated-agent/delivery-dispatch.ts`, add an import at the top:

```typescript
import { appendBotHistoryEntry } from "../../auto-reply/reply/bot-history.js";
```

Then modify the `deliverViaDirect` closure. Find line 275 (`delivered = deliveryResults.length > 0;`) and replace:

```typescript
delivered = deliveryResults.length > 0;
return null;
```

with:

```typescript
delivered = deliveryResults.length > 0;
// Record delivered bot message for later flush into the target chat's
// session transcript. Other proactive outbound paths that bypass the
// `mirror` parameter should add their own appendBotHistoryEntry call.
if (delivered && synthesizedText?.trim()) {
  appendBotHistoryEntry({
    channel: delivery.channel,
    to: delivery.to,
    accountId: delivery.accountId,
    threadId: delivery.threadId != null ? String(delivery.threadId) : undefined,
    text: synthesizedText.trim(),
    timestamp: Date.now(),
    source: "cron",
  }).catch(() => {}); // best-effort, don't block delivery
}
return null;
```

- [ ] **Step 2: Run type check**

Run: `pnpm tsgo`
Expected: No new errors

- [ ] **Step 3: Run existing delivery-dispatch tests to verify no regressions**

Run: `pnpm vitest run src/cron/isolated-agent/delivery-dispatch`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
scripts/committer "feat(bot-history): record cron delivery to pending store" \
  src/cron/isolated-agent/delivery-dispatch.ts
```

---

### Task 5: Flush Point in get-reply.ts

**Files:**

- Modify: `src/auto-reply/reply/get-reply.ts:174`

- [ ] **Step 1: Add the flush call after initSessionState destructuring**

In `src/auto-reply/reply/get-reply.ts`, add an import at the top:

```typescript
import { flushBotHistoryToTranscript } from "./bot-history.js";
```

Then find line 174 (`} = sessionState;`) and insert after it:

```typescript
// Flush pending bot messages (e.g. cron deliveries) into the current
// session transcript so the LLM sees them as prior assistant messages.
// OriginatingChannel and OriginatingTo are optional on MsgContext;
// skip flush when either is missing (e.g. internal/non-channel messages).
if (finalized.OriginatingChannel && finalized.OriginatingTo) {
  await flushBotHistoryToTranscript({
    channel: finalized.OriginatingChannel,
    to: finalized.OriginatingTo,
    accountId: finalized.AccountId,
    threadId: finalized.MessageThreadId != null ? String(finalized.MessageThreadId) : undefined,
    sessionKey,
    agentId,
  }).catch(() => {}); // best-effort
}
```

- [ ] **Step 2: Run type check**

Run: `pnpm tsgo`
Expected: No new errors. The `if` guard narrows `OriginatingChannel` and `OriginatingTo` from optional to required, satisfying `flushBotHistoryToTranscript`'s `channel: string` / `to: string` parameter types.

- [ ] **Step 3: Run existing get-reply tests to verify no regressions**

Run: `pnpm vitest run src/auto-reply/reply/get-reply`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
scripts/committer "feat(bot-history): flush pending entries on inbound message" \
  src/auto-reply/reply/get-reply.ts
```

---

### Task 6: Final Verification

- [ ] **Step 1: Run full type check**

Run: `pnpm tsgo`
Expected: No errors

- [ ] **Step 2: Run lint/format check**

Run: `pnpm check`
Expected: No errors. If formatting issues, run `pnpm format:fix` and commit.

- [ ] **Step 3: Run full test suite for affected areas**

Run: `pnpm vitest run src/auto-reply/reply/bot-history.test.ts src/cron/isolated-agent/ src/auto-reply/reply/get-reply`
Expected: All PASS

- [ ] **Step 4: Run broader test suite**

Run: `pnpm test`
Expected: All PASS, no regressions
