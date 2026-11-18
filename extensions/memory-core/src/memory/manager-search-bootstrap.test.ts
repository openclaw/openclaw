import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

const fixture = createManagerIndexFixture({
  getMemorySearchManager,
  closeAllMemorySearchManagers,
});
const {
  provider: providerFixture,
  createConfig: createCfg,
  getFreshManager,
  getFtsSessionManager,
  getPersistentManager,
  seedSessionTranscript,
} = fixture;

async function emptyManager(options: Parameters<typeof createCfg>[0]) {
  await fs.unlink(path.join(fixture.paths.memory, "2026-01-12.md"));
  const cfg = createCfg(options);
  return { cfg, manager: await getFreshManager(cfg, "cli") };
}
const seedTranscript = (sessionId: string, content: string) =>
  seedSessionTranscript({
    sessionId,
    messages: [{ role: "assistant", timestamp: "2026-04-07T15:25:04.113Z", content }],
  });

it.each([
  { source: "memory", provider: "none" },
  { source: "sessions", provider: "openai" },
] as const)(
  "discovers new $source content with $provider after empty CLI searches without repeatedly repairing the index",
  async ({ source, provider }) => {
    providerFixture.forceNoProvider = provider === "none";
    const empty = await emptyManager({
      provider,
      sources: ["memory", "sessions"],
      rememberAcrossConversations: true,
      minScore: 0,
    });
    const { cfg } = empty;
    let { manager } = empty;
    expect(manager.status().fts?.available).toBe(true);
    expect(manager.status().sources).toEqual(["memory", "sessions"]);

    await expect(manager.search("alpha", { minScore: 0 })).resolves.toEqual([]);
    const initialRepairSequence = asOptionalRecord(
      manager.status().custom?.automaticRebuildNotice,
    )?.sequence;
    expect(initialRepairSequence).toEqual(expect.any(Number));
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(manager.search("alpha", { minScore: 0 })).resolves.toEqual([]);
      expect(manager.status().custom?.automaticRebuildNotice).toMatchObject({
        sequence: initialRepairSequence,
      });
    }

    for (let index = 0; index < 2; index++) {
      const content = `alpha sentinel ${index} is now searchable.`;
      if (source === "memory") {
        await fs.writeFile(path.join(fixture.paths.memory, `new-note-${index}.md`), content);
      } else {
        await seedTranscript(`after-empty-search-${index}`, content);
      }
      if (index === 1) {
        manager = await getFreshManager(cfg);
        if (provider !== "none") {
          expect(manager.status().vector?.index?.state).toBe("complete");
        }
        await manager.sync({ reason: "cli" });
      }
      const discovered = await manager.search("alpha", { minScore: 0 });
      expect(discovered).toHaveLength(index + 1);
      expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      if (index === 0) {
        if (provider !== "none") {
          expect(manager.status().vector?.index?.state).toBe("complete");
        }
        expect(manager.status().custom?.automaticRebuildNotice).toMatchObject({
          sequence: initialRepairSequence,
        });
        await manager.close();
      } else {
        expect(manager.status().custom?.automaticRebuildNotice).toMatchObject({ sequence: 0 });
      }
    }

    const results = await manager.search("alpha", { minScore: 0 });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.source === source)).toBe(true);
    const snippets = results.map((result) => result.snippet).join("\n");
    expect(snippets).toContain("alpha sentinel 0");
    expect(snippets).toContain("alpha sentinel 1");
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    if (provider !== "none") {
      using observer = new DatabaseSync(
        expectDefined(manager.status().dbPath, "memory database path"),
        { readOnly: true, allowExtension: true },
      );
      expect((await loadSqliteVecExtension({ db: observer })).ok).toBe(true);
      const vectors = observer.prepare("SELECT id FROM memory_index_chunks_vec ORDER BY id").all();
      const chunks = observer.prepare("SELECT id FROM memory_index_chunks ORDER BY id").all();
      expect(vectors).toHaveLength(2);
      expect(vectors).toEqual(chunks);
    }
    await manager.close();
    const reopened = await getFreshManager(cfg, "cli");
    await expect(reopened.search("alpha", { minScore: 0 })).resolves.toHaveLength(2);
    expect(reopened.status().custom?.indexIdentity).toEqual({ status: "valid" });
    if (provider !== "none") {
      expect(reopened.status().vector?.dims).toBe(4);
    }
  },
);

it("finds the first note through the configured fallback after an empty semantic bootstrap", async () => {
  const primaryFailure = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(providerFixture.createLocalWorkerExitError())
    .mockResolvedValue(undefined);
  providerFixture.beforeEmbedBatch = primaryFailure;
  const { manager } = await emptyManager({ fallback: "fallback-provider", minScore: 0 });
  await expect(manager.search("alpha", { minScore: 0 })).resolves.toEqual([]);
  expect(manager.status().provider).toBe("mock");
  expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });

  await fs.writeFile(
    path.join(fixture.paths.workspace, "MEMORY.md"),
    "alpha sentinel is now searchable.",
  );
  const results = await manager.search("alpha", { minScore: 0 });

  expect(primaryFailure).toHaveBeenCalled();
  expect(manager.status()).toMatchObject({ provider: "fallback-provider", dirty: false });
  expect(results[0]).toMatchObject({
    path: "MEMORY.md",
    snippet: expect.stringContaining("alpha sentinel"),
  });
  expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
});

it("returns before provider or index bootstrap for a blank query", async () => {
  const manager = await getPersistentManager(createCfg({ provider: "required-provider" }));
  providerFixture.providerCalls = [];

  await expect(manager.search(" \n\t ")).resolves.toStrictEqual([]);

  expect(providerFixture.providerCalls).toHaveLength(0);
});
it("bootstraps an empty index on first search so session transcript hits are available", async () => {
  const manager = await getFtsSessionManager();
  if (!manager) {
    return;
  }

  await seedTranscript("session-bootstrap", "The current Project Nebula codename is ORBIT-10.");

  const results = await manager.search("current Project Nebula codename ORBIT-10", {
    minScore: 0,
    maxResults: 3,
  });

  expect(results[0]).toMatchObject({
    source: "sessions",
    snippet: expect.stringContaining("ORBIT-10"),
  });
});
