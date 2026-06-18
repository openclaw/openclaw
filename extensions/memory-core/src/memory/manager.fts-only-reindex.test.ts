// Memory Core tests cover manager.fts only reindex plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

const createEmbeddingProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    requestedProvider: "auto",
    provider: null,
    providerUnavailableReason: "No embeddings provider available.",
  })),
);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager FTS-only reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Alpha topic\n\nKeep this note.");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
    indexPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await closeAllMemorySearchManagers();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function createManager(
    params: { provider?: string; vectorEnabled?: boolean; onSearch?: boolean } = {},
  ): Promise<MemoryIndexManager> {
    const store =
      params.vectorEnabled === undefined
        ? undefined
        : { vector: { enabled: params.vectorEnabled } };
    const cfg = {
      memory: {
        backend: "builtin",
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: params.provider ?? "auto",
            model: "",
            store,
            cache: { enabled: false },
            sync: {
              watch: false,
              onSessionStart: false,
              onSearch: params.onSearch ?? false,
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  function countChunksContaining(term: string): number {
    const db = new DatabaseSync(indexPath);
    try {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM memory_index_chunks WHERE text LIKE ?`)
        .get(`%${term}%`) as { c: number } | undefined;
      return row?.c ?? 0;
    } finally {
      db.close();
    }
  }

  function writeExistingMeta(memoryManager: MemoryIndexManager, model: string): void {
    const metaWriter = memoryManager as unknown as {
      writeMeta(meta: MemoryIndexMeta): void;
    };
    metaWriter.writeMeta({
      model,
      provider: "openai",
      chunkTokens: 600,
      chunkOverlap: 120,
      sources: ["memory"],
    });
  }

  it("preserves indexed chunks across forced reindex in FTS-only mode", async () => {
    const memoryManager = await createManager();

    await memoryManager.sync({ force: true });
    const firstStatus = memoryManager.status();
    expect(firstStatus.chunks).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);

    await memoryManager.sync({ force: true });
    const secondStatus = memoryManager.status();
    expect(secondStatus.chunks).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("syncs explicit provider-none memory without resolving an embedding provider", async () => {
    const memoryManager = await createManager({ provider: "none", vectorEnabled: false });

    await memoryManager.sync({ force: true });

    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(memoryManager.status().custom?.providerState).toEqual({
      mode: "fts-only",
      reason: "No embedding provider available (FTS-only mode)",
      attemptedProviderId: "none",
    });
  });

  it("reports explicit provider-none probes as FTS-only without resolving providers", async () => {
    const memoryManager = await createManager({ provider: "none", vectorEnabled: false });

    await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: "No embedding provider available (FTS-only mode)",
    });

    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(memoryManager.status().custom?.providerState).toEqual({
      mode: "fts-only",
      reason: "No embedding provider available (FTS-only mode)",
      attemptedProviderId: "none",
    });
  });

  it("forces provider-none memory to FTS-only when vector config is omitted", async () => {
    const memoryManager = await createManager({ provider: "none" });

    await memoryManager.sync({ force: true });

    const status = memoryManager.status();
    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(status.vector).toMatchObject({ enabled: false });
    expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("still initializes configured providers when vector storage is disabled", async () => {
    const memoryManager = await createManager({ provider: "auto", vectorEnabled: false });

    await memoryManager.sync({ force: true });

    expect(createEmbeddingProviderMock).toHaveBeenCalledOnce();
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("refreshes FTS-only indexed content after memory file updates", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });

    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Beta refresh marker\n\nUpdated memory content.",
    );
    await memoryManager.sync({ force: true });

    expect(countChunksContaining("refresh marker")).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBe(0);
  });

  it("aborts instead of downgrading an existing semantic index to FTS-only", async () => {
    const memoryManager = await createManager();
    writeExistingMeta(memoryManager, "mock-embed");

    await expect(memoryManager.sync({ force: true })).rejects.toThrow(
      "Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: mock-embed).",
    );
    expect(memoryManager.status().provider).toBe("openai");
  });

  it("rebuilds legacy FTS-only indexes that lack the path-prefixed text format (#94102)", async () => {
    // Reproduce a clean pre-upgrade FTS-only index: build it once, then drop the
    // ftsTextFormat marker and replace each FTS row with the legacy body-only payload.
    // Without the identity gate the next non-forced sync would skip unchanged file
    // hashes and leave filename/date queries broken; the gate must mark the index
    // dirty so the rebuild restores path tokens in chunks_fts.text.
    const filenameStem = "2026-06-17-1649";
    const memoryFilePath = path.join(workspaceDir, "memory", `${filenameStem}.md`);
    await fs.writeFile(
      memoryFilePath,
      "Legacy memory entry body that does not mention the date stem.",
    );

    let memoryManager = await createManager({ provider: "none", vectorEnabled: false });
    await memoryManager.sync({ force: true });
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });

    const downgradeDb = new DatabaseSync(indexPath);
    try {
      const metaRow = downgradeDb
        .prepare(`SELECT value FROM meta WHERE key = 'memory_index_meta_v1'`)
        .get() as { value: string } | undefined;
      const meta = JSON.parse(metaRow?.value ?? "{}") as Record<string, unknown>;
      delete meta.ftsTextFormat;
      downgradeDb
        .prepare(`UPDATE meta SET value = ? WHERE key = 'memory_index_meta_v1'`)
        .run(JSON.stringify(meta));
      const ftsRows = downgradeDb.prepare(`SELECT id, text FROM chunks_fts`).all() as Array<{
        id: string;
        text: string;
      }>;
      const stripPrefix = downgradeDb.prepare(`UPDATE chunks_fts SET text = ? WHERE id = ?`);
      const prefix = `memory/${filenameStem}.md\n`;
      for (const row of ftsRows) {
        const legacyText = row.text.startsWith(prefix) ? row.text.slice(prefix.length) : row.text;
        stripPrefix.run(legacyText, row.id);
      }
    } finally {
      downgradeDb.close();
    }

    await memoryManager.close();
    manager = null;

    memoryManager = await createManager({ provider: "none", vectorEnabled: false });
    expect(memoryManager.status().custom?.indexIdentity).toMatchObject({
      status: "mismatched",
    });

    // Plain sync with reason "cli" (the path `openclaw memory search ...` takes) — the
    // identity gate, not a force flag, must trigger the rebuild on upgrade.
    await memoryManager.sync({ reason: "cli" });

    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });

    const verifyDb = new DatabaseSync(indexPath);
    try {
      const metaRow = verifyDb
        .prepare(`SELECT value FROM meta WHERE key = 'memory_index_meta_v1'`)
        .get() as { value: string } | undefined;
      const meta = JSON.parse(metaRow?.value ?? "{}") as Record<string, unknown>;
      expect(meta.ftsTextFormat).toBe("path-prefixed-v1");
      // FTS5 unicode61 splits on hyphens; query each token individually to confirm
      // the filename made it into chunks_fts.text after the rebuild.
      const ftsHit = verifyDb
        .prepare(`SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?`)
        .get("1649") as { c: number } | undefined;
      expect(ftsHit?.c ?? 0).toBeGreaterThan(0);
    } finally {
      verifyDb.close();
    }
  });

  it("self-heals legacy FTS-only indexes during shared memory_search (#94102)", async () => {
    // Same upgrade scenario as the prior test, but exercises the path real users hit:
    // they call manager.search()/memory_search rather than running the CLI sync. The
    // self-heal trigger has to fire on the default `reason: "search"` path too, not
    // just `reason: "cli"`.
    const filenameStem = "2026-06-17-1701";
    const memoryFilePath = path.join(workspaceDir, "memory", `${filenameStem}.md`);
    await fs.writeFile(
      memoryFilePath,
      "Token has been expired or revoked Google OAuth Testing mode\n",
    );

    let memoryManager = await createManager({
      provider: "none",
      vectorEnabled: false,
      onSearch: true,
    });
    await memoryManager.sync({ force: true });

    const downgradeDb = new DatabaseSync(indexPath);
    try {
      const metaRow = downgradeDb
        .prepare(`SELECT value FROM meta WHERE key = 'memory_index_meta_v1'`)
        .get() as { value: string } | undefined;
      const meta = JSON.parse(metaRow?.value ?? "{}") as Record<string, unknown>;
      delete meta.ftsTextFormat;
      downgradeDb
        .prepare(`UPDATE meta SET value = ? WHERE key = 'memory_index_meta_v1'`)
        .run(JSON.stringify(meta));
      const ftsRows = downgradeDb.prepare(`SELECT id, text FROM chunks_fts`).all() as Array<{
        id: string;
        text: string;
      }>;
      const stripPrefix = downgradeDb.prepare(`UPDATE chunks_fts SET text = ? WHERE id = ?`);
      const prefix = `memory/${filenameStem}.md\n`;
      for (const row of ftsRows) {
        const legacyText = row.text.startsWith(prefix) ? row.text.slice(prefix.length) : row.text;
        stripPrefix.run(legacyText, row.id);
      }
    } finally {
      downgradeDb.close();
    }

    await memoryManager.close();
    manager = null;

    memoryManager = await createManager({
      provider: "none",
      vectorEnabled: false,
      onSearch: true,
    });
    expect(memoryManager.status().custom?.indexIdentity).toMatchObject({
      status: "mismatched",
    });

    // The user-facing entry point — no force, no reason="cli" — must self-heal.
    await memoryManager.search(filenameStem);

    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });

    const verifyDb = new DatabaseSync(indexPath);
    try {
      const metaRow = verifyDb
        .prepare(`SELECT value FROM meta WHERE key = 'memory_index_meta_v1'`)
        .get() as { value: string } | undefined;
      const meta = JSON.parse(metaRow?.value ?? "{}") as Record<string, unknown>;
      expect(meta.ftsTextFormat).toBe("path-prefixed-v1");
      const ftsHit = verifyDb
        .prepare(`SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?`)
        .get("1701") as { c: number } | undefined;
      expect(ftsHit?.c ?? 0).toBeGreaterThan(0);
    } finally {
      verifyDb.close();
    }
  });
});
