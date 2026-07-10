// Memory Core tests cover incremental session chunk-delta sync behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearMemoryEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";

// Real sqlite indexing; avoid flaking when sharing a packed CI shard.
vi.setConfig({ testTimeout: 240_000 });

const embedState = vi.hoisted(() => ({
  batches: [] as string[][],
  failNextBatch: false,
  noProvider: false,
}));

vi.mock("./embeddings.js", () => ({
  resolveEmbeddingProviderFallbackModel: (_providerId: string, fallbackSourceModel: string) =>
    fallbackSourceModel,
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: async () =>
    embedState.noProvider
      ? {
          provider: null,
          requestedProvider: "auto",
          providerUnavailableReason: "No API key found for provider",
        }
      : {
          requestedProvider: "openai",
          provider: {
            id: "mock",
            model: "mock-embed",
            maxInputTokens: 8192,
            embedQuery: async () => [1, 0, 0],
            embedBatch: async (texts: string[]) => {
              if (embedState.failNextBatch) {
                embedState.failNextBatch = false;
                throw new Error("mock embeddings unavailable");
              }
              embedState.batches.push([...texts]);
              return texts.map(() => [1, 0, 0]);
            },
          },
        },
}));

type ChunkRow = { id: string; start_line: number; text: string; updated_at: number };

function sessionMessageLine(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: "message",
    message: {
      role,
      timestamp: "2026-07-01T10:00:00.000Z",
      content: [{ type: "text", text }],
    },
  });
}

function transcriptTurns(from: number, to: number): string {
  const lines: string[] = [];
  for (let turn = from; turn <= to; turn += 1) {
    const id = String(turn).padStart(3, "0");
    lines.push(sessionMessageLine("user", `turn ${id} question about topic-${id}`));
    lines.push(sessionMessageLine("assistant", `turn ${id} answer covering topic-${id}`));
  }
  return lines.join("\n") + "\n";
}

describe("memory session chunk-delta sync", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const managersForCleanup = new Set<MemoryIndexManager>();

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-delta-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(Array.from(managersForCleanup).map((manager) => manager.close()));
    managersForCleanup.clear();
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    clearRegistry();
    embedState.batches = [];
    embedState.failNextBatch = false;
    embedState.noProvider = false;
    if (originalStateDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
    } else {
      Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStateDir);
    }
  });

  function createCfg(): Parameters<typeof getMemorySearchManager>[0]["cfg"] {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            model: "mock-embed",
            store: { vector: { enabled: false } },
            // Small chunks so one transcript spans several rows.
            chunking: { tokens: 64, overlap: 16 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            // Hybrid enables FTS so the tests exercise chunk/FTS row parity.
            query: { minScore: 0, hybrid: { enabled: true } },
            // Keep the embedding cache out of the way so embedBatch calls
            // measure exactly which chunks the sync re-embeds.
            cache: { enabled: false },
            sources: ["sessions"],
            experimental: { sessionMemory: true },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  async function setUpManager(stateDirName: string): Promise<{
    manager: MemoryIndexManager;
    sessionFile: string;
  }> {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", path.join(fixtureRoot, stateDirName));
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "session-delta.jsonl");
    const result = await getMemorySearchManager({ cfg: createCfg(), agentId: "main" });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    const manager = result.manager as unknown as MemoryIndexManager;
    managersForCleanup.add(manager);
    return { manager, sessionFile };
  }

  function markSessionDirty(manager: MemoryIndexManager, sessionFile: string): void {
    (manager as unknown as { sessionsDirty: boolean }).sessionsDirty = true;
    (manager as unknown as { sessionsDirtyFiles: Set<string> }).sessionsDirtyFiles.add(sessionFile);
  }

  function readSessionChunkRows(manager: MemoryIndexManager): ChunkRow[] {
    const db = Reflect.get(manager, "db") as {
      prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
    };
    return db
      .prepare(
        `SELECT id, start_line, text, updated_at FROM memory_index_chunks
         WHERE source = 'sessions' ORDER BY start_line, id`,
      )
      .all() as ChunkRow[];
  }

  function readFtsRowCount(manager: MemoryIndexManager): number | null {
    if (!(manager.status().fts?.available ?? false)) {
      return null;
    }
    const db = Reflect.get(manager, "db") as {
      prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
    };
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM memory_index_chunks_fts WHERE source = 'sessions'`)
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  it("re-embeds only appended chunks and leaves unchanged rows untouched", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-append");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const before = readSessionChunkRows(manager);
    expect(before.length).toBeGreaterThan(2);
    const firstChunkText = before[0]?.text ?? "";

    embedState.batches = [];
    await fs.appendFile(sessionFile, transcriptTurns(31, 34), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const after = readSessionChunkRows(manager);
    expect(after.length).toBeGreaterThanOrEqual(before.length);

    // The append only re-embeds trailing/new chunks, never the whole file.
    const embedded = embedState.batches.flat();
    expect(embedded.length).toBeGreaterThan(0);
    expect(embedded.length).toBeLessThan(after.length);
    expect(embedded).not.toContain(firstChunkText);

    // Unchanged rows keep their identity and updated_at (no delete-reinsert).
    const afterById = new Map(after.map((row) => [row.id, row]));
    const preserved = before.filter((row) => afterById.get(row.id)?.updated_at === row.updated_at);
    expect(preserved.length).toBeGreaterThanOrEqual(before.length - 2);

    // Appended content is indexed and FTS stays in lockstep with chunk rows.
    expect(after.some((row) => row.text.includes("topic-034"))).toBe(true);
    const ftsCount = readFtsRowCount(manager);
    if (ftsCount !== null) {
      expect(ftsCount).toBe(after.length);
    }
  });

  it("falls back to a clean rebuild when the transcript is compacted", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-compact");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    expect(readSessionChunkRows(manager).length).toBeGreaterThan(2);

    // Compaction rewrites the transcript: old turns collapse into a summary.
    const compacted =
      sessionMessageLine("assistant", "compaction summary replacing earlier turns") +
      "\n" +
      transcriptTurns(29, 32);
    await fs.writeFile(sessionFile, compacted, "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const after = readSessionChunkRows(manager);
    expect(after.length).toBeGreaterThan(0);
    // No stale rows survive from the pre-compaction transcript.
    expect(after.some((row) => row.text.includes("topic-005"))).toBe(false);
    expect(after.some((row) => row.text.includes("compaction summary"))).toBe(true);
    expect(after.some((row) => row.text.includes("topic-032"))).toBe(true);
    const ftsCount = readFtsRowCount(manager);
    if (ftsCount !== null) {
      expect(ftsCount).toBe(after.length);
    }
  });

  it("keeps the existing index intact when embedding fails mid-delta and converges on retry", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-retry");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    const before = readSessionChunkRows(manager);

    await fs.appendFile(sessionFile, transcriptTurns(31, 34), "utf8");
    markSessionDirty(manager, sessionFile);
    embedState.failNextBatch = true;
    await expect(manager.sync({ reason: "test" })).rejects.toThrow();

    // Embeddings are computed before any deletion, so a failure leaves the
    // previously indexed rows fully intact.
    const afterFailure = readSessionChunkRows(manager);
    expect(afterFailure).toStrictEqual(before);

    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    const converged = readSessionChunkRows(manager);
    expect(converged.some((row) => row.text.includes("topic-034"))).toBe(true);
    const ftsCount = readFtsRowCount(manager);
    if (ftsCount !== null) {
      expect(ftsCount).toBe(converged.length);
    }
  });

  it("re-embeds chunks that were persisted with an empty embedding", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-empty-embedding");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    // Simulate a partial provider failure that persisted an empty embedding.
    const db = Reflect.get(manager, "db") as {
      prepare: (sql: string) => { run: (...params: unknown[]) => void };
    };
    const degraded = readSessionChunkRows(manager)[0];
    db.prepare(`UPDATE memory_index_chunks SET embedding = '[]' WHERE id = ?`).run(degraded?.id);

    embedState.batches = [];
    await fs.appendFile(sessionFile, transcriptTurns(31, 32), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    // The degraded chunk is re-embedded alongside the appended chunks instead
    // of being frozen as "unchanged" without a usable embedding.
    expect(embedState.batches.flat()).toContain(degraded?.text ?? "");
    const healed = readSessionChunkRows(manager).find((row) => row.id === degraded?.id);
    expect(healed).toBeDefined();
  });

  it("applies deltas in FTS-only mode without an embedding provider", async () => {
    embedState.noProvider = true;
    const { manager, sessionFile } = await setUpManager(".state-delta-fts-only");
    if (!(manager.status().fts?.available ?? false)) {
      return;
    }

    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    const before = readSessionChunkRows(manager);
    expect(before.length).toBeGreaterThan(2);

    await fs.appendFile(sessionFile, transcriptTurns(31, 34), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const after = readSessionChunkRows(manager);
    const afterById = new Map(after.map((row) => [row.id, row]));
    const preserved = before.filter((row) => afterById.get(row.id)?.updated_at === row.updated_at);
    expect(preserved.length).toBeGreaterThanOrEqual(before.length - 2);
    expect(after.some((row) => row.text.includes("topic-034"))).toBe(true);
    expect(readFtsRowCount(manager)).toBe(after.length);
  });
});
