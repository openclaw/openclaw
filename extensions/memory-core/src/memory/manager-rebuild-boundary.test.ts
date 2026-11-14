import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { registerEmbeddingProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { ReindexHarness } from "./manager-reindex-harness.test-support.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

// Release proof: real file preparation, read worker, staged writer and shadow publication.
// Provider responses and unsolicited filesystem observations are controlled; database operations are real.
describe("large memory rebuild boundary", () => {
  let root = "";
  let manager: MemoryIndexManager | undefined;
  let calls = 0;
  const dimensions = 4096;
  const vector = Array.from({ length: dimensions }, (_, i) => ((i % 31) - 15) / 37);
  vector.splice(0, 4, Number.MIN_VALUE, 1 + Number.EPSILON, -0.0000010000000000000002, 0);
  beforeEach(async () => {
    calls = 0;
    root = tempDirs.make("memory-rebuild-boundary-");
    await fs.mkdir(path.join(root, "memory"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    registerEmbeddingProvider({
      id: "openai",
      transport: "remote",
      create: async () => ({
        provider: {
          id: "openai",
          model: "boundary",
          maxInputTokens: 8192,
          embed: async () => vector.slice(),
          embedBatch: async (inputs) => {
            calls += inputs.length;
            return inputs.map(() => vector.slice());
          },
        },
      }),
    });
  });
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      await manager?.close();
      manager = undefined;
      const { closeAllMemorySearchManagers } = await import("./index.js");
      await closeAllMemorySearchManagers();
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      clearRuntimeConfigSnapshot();
      resetPluginStateStoreForTests();
      vi.unstubAllEnvs();
      cleanup();
    }),
  );
  async function open(cacheEnabled: boolean) {
    const cfg: OpenClawConfig = isolateMemoryManagerTestConfig({
      memory: {
        search: {
          provider: "openai",
          model: "boundary",
          sources: ["memory"],
          store: { vector: { enabled: false } },
          cache: { enabled: cacheEnabled },
        },
      },
      agents: { defaults: { workspace: root }, entries: { main: {} } },
    });
    setRuntimeConfigSnapshot(cfg);
    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({
      cfg,
      agentId: "main",
      runInBackgroundContext: runInMemoryTestBackgroundContext,
    });
    if (!result.manager || !("sync" in result.manager)) {
      throw new Error(result.error ?? "No manager");
    }
    manager = result.manager as MemoryIndexManager;
    return manager;
  }
  function fingerprint(db: DatabaseSync) {
    const hash = createHash("sha256");
    let count = 0;
    for (const row of db
      .prepare("SELECT hash, embedding FROM memory_index_chunks ORDER BY hash")
      .iterate()) {
      hash.update(String(row.hash));
      if (!(row.embedding instanceof Uint8Array)) {
        throw new Error("missing stored vector");
      }
      hash.update(row.embedding);
      count++;
    }
    return { digest: hash.digest("hex"), count };
  }
  it.each([true, false])(
    "rebuilds multipage vectors through real workers (cache=%s)",
    async (cacheEnabled) => {
      // Separate long lines yield >256 unique chunks, crossing the 8 MiB/4096-dimension read page.
      await fs.writeFile(
        path.join(root, "memory", "large.md"),
        Array.from(
          { length: 1200 },
          (_, i) =>
            "Fact " +
            i.toString().padStart(4, "0") +
            ": " +
            "independent synthetic memory evidence ".repeat(8),
        ).join("\n"),
      );
      const m = await open(cacheEnabled);
      const harness = m as unknown as ReindexHarness;
      const pages: number[] = [];
      const reads = vi.spyOn(MemoryIndexDatabase.prototype, "read");
      const before = process.memoryUsage();
      await m.sync({ reason: "cli", force: true });
      const first = fingerprint(harness.db);
      expect(first.count).toBeGreaterThan(256);
      expect(calls).toBe(first.count);
      // Independent binary64 oracle, not merely first-run versus replay equality.
      const expected = Buffer.alloc(dimensions * 8);
      vector.forEach((value, i) => expected.writeDoubleLE(value, i * 8));
      for (const row of harness.db.prepare("SELECT embedding FROM memory_index_chunks").iterate()) {
        if (!(row.embedding instanceof Uint8Array)) {
          throw new Error("Missing vector BLOB");
        }
        expect(Buffer.from(row.embedding).equals(expected)).toBe(true);
      }
      calls = 0;
      reads.mockClear();
      await m.sync({ reason: "cli", force: true });
      let largestRead = 0;
      for (const [index, [command]] of reads.mock.calls.entries()) {
        if (command.type === "cache.read") {
          pages.push(command.input.hashes.length);
          const outcome = reads.mock.results[index];
          if (outcome?.type !== "return") {
            throw new Error("Cache read did not return");
          }
          largestRead = Math.max(largestRead, serialize(await outcome.value).byteLength);
        }
      }
      expect(largestRead).toBeLessThan(12 * 1024 * 1024);
      expect(fingerprint(harness.db)).toEqual(first);
      expect(calls).toBe(cacheEnabled ? 0 : first.count);
      if (cacheEnabled) {
        expect(pages.length).toBeGreaterThan(1);
        expect(Math.max(...pages)).toBeLessThanOrEqual(256);
      } else {
        expect(pages).toEqual([]);
      }
      console.log(
        "REBUILD_BOUNDARY",
        JSON.stringify({
          cacheEnabled,
          chunks: first.count,
          dimensions,
          pages,
          largestRead,
          vectorBytes: first.count * dimensions * 8,
          before,
          after: process.memoryUsage(),
        }),
      );
    },
    120_000,
  );
});
