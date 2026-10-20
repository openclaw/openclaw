import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  resolveDatabaseFamilyEngines,
  withDatabaseEngineSelection,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./memory/index.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";
import { createMemorySearchTool, testing } from "./tools.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("./memory/watcher-test-support.js");
  return createMemoryObservationHarness();
});
// Keep controlled invalidations in-process; native worker transport has separate coverage.
vi.mock("./memory/local-file-watcher.js", async (original) => ({
  ...(await original<typeof import("./memory/local-file-watcher.js")>()),
  LocalMemoryFileWatcher: (await import("./memory/file-watcher.js")).MemoryFileWatcher,
}));
// File contents and indexing are real; the fixture delivers invalidations without OS timing.
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
  watch: observer.watch,
}));

// The external embedding service returns fixed, independent cosine fixtures.
vi.mock("./memory/embeddings.js", async (original) => ({
  ...(await original<typeof import("./memory/embeddings.js")>()),
  resolveEmbeddingProviderIndexIdentity: () => ({
    provider: { id: "openai", model: "product-fixture" },
  }),
  createEmbeddingProvider: async () => {
    const embed = (text: string) =>
      text.includes("nearest-decoy")
        ? [1, 0, 0]
        : text.includes("launch plan")
          ? [4, 3, 0]
          : [0, 1, 0];
    return {
      requestedProvider: "openai",
      provider: {
        id: "openai",
        model: "product-fixture",
        embed: async () => [1, 0, 0],
        embedBatch: async (inputs: EmbeddingInput[]) =>
          inputs.map((input) => embed(typeof input === "string" ? input : input.text)),
      },
    };
  },
}));

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `memory_product_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
type Hit = { path: string; source: string; score: number; snippet: string };
type Result = { results: Hit[]; unavailable?: boolean; error?: string; action?: string };

describe.skipIf(!connection)("PostgreSQL memory_search product flows", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let config: OpenClawConfig;
  let run: ReturnType<typeof AsyncLocalStorage.snapshot>;
  const managers = new Map<string, MemorySearchManager>();
  const workspaces = new Map<string, string>();
  const ids = ["main", "other", "semantic", "trigram"];
  const client = new pg.Client({ connectionString: connection });

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "memory-search-product-pg",
      layout: "state-only",
    });
    await configureMemoryCoreDreamingStateForTests();
    await client.connect();
    for (const id of ids) {
      const workspace = path.join(state.workspaceDir, id);
      workspaces.set(id, workspace);
      await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
    }
    config = {
      database: { engine: "postgres" },
      plugins: { enabled: false },
      tools: { sessions: { visibility: "agent" } },
      agents: {
        entries: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              workspace: workspaces.get(id)!,
              ...(id === "semantic"
                ? {
                    memory: {
                      search: {
                        provider: "openai",
                        model: "product-fixture",
                        store: { vector: { enabled: true } },
                      },
                    },
                  }
                : id === "trigram"
                  ? { memory: { search: { store: { fts: { tokenizer: "trigram" } } } } }
                  : {}),
            },
          ]),
        ),
      },
      memory: {
        citations: "off",
        search: {
          provider: "none",
          fallback: "none",
          sources: ["memory", "sessions"],
          rememberAcrossConversations: true,
          store: { vector: { enabled: false } },
          query: { minScore: 0, maxResults: 20 },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    run = withDatabaseEngineSelection(
      {
        effectiveEngines: resolveDatabaseFamilyEngines(config),
        postgres: { connection: connection!, schemaPrefix: prefix },
      },
      () => AsyncLocalStorage.snapshot(),
    );
  });

  afterAll(async () => {
    await run(async () => {
      await closeAllMemorySearchManagers();
      resetMemoryCoreDreamingStateForTests();
      await state.cleanup();
    });
    try {
      const schemas = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
        [prefix.length + 1, `${prefix}_`],
      );
      for (const { nspname } of schemas.rows) {
        await client.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  async function write(agentId: string, name: string, text: string) {
    const file = path.join(workspaces.get(agentId)!, "memory", name);
    await fs.writeFile(file, text);
    invalidate(agentId, file);
  }

  function invalidate(agentId: string, file: string) {
    let observed = false;
    for (const entry of observer.observations) {
      const relative = path.relative(entry.root.rootDir, file);
      if (!relative.startsWith("..")) {
        observed = true;
        entry.dirty([{ path: relative, type: "structural" }]);
      }
    }
    if (managers.has(agentId)) {
      expect(observed, "Expected the active memory watcher to receive fixture invalidation").toBe(
        true,
      );
    }
  }

  async function sync(agentId = "main", force = false) {
    return await run(async () => {
      let manager = managers.get(agentId);
      if (!manager) {
        const result = await getMemorySearchManager({
          cfg: config,
          agentId,
          runInBackgroundContext: run,
        });
        if (!result.manager) {
          throw new Error(result.error ?? "Expected memory manager");
        }
        manager = result.manager;
        managers.set(agentId, manager);
      }
      if (!manager.sync) {
        throw new Error("Expected a memory indexing manager");
      }
      await manager.sync({ reason: "cli", force });
      return manager;
    });
  }

  async function search(
    query: string,
    options: { agentId?: string; corpus?: "memory" | "sessions"; maxResults?: number } = {},
  ) {
    return await run(async () => {
      testing.resetMemorySearchToolCooldowns();
      const tool = createMemorySearchTool({
        config,
        agentId: options.agentId ?? "main",
        agentSessionKey: `agent:${options.agentId ?? "main"}:main`,
        runInBackgroundContext: run,
      });
      if (!tool) {
        throw new Error("Expected public memory_search tool");
      }
      const result = await tool.execute("postgres-product-search", {
        query,
        corpus: options.corpus ?? "memory",
        maxResults: options.maxResults ?? 20,
      });
      return result.details as Result;
    });
  }

  async function transcript(agentId: string, sessionId: string, text: string) {
    return await run(async () => {
      const target = {
        agentId,
        sessionKey: `agent:${agentId}:telegram:direct:${sessionId}`,
        storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
      };
      await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
      await appendSessionTranscriptMessageByIdentity({
        ...target,
        sessionId,
        message: {
          role: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: [{ type: "text", text }],
        },
      });
    });
  }

  it("publishes body and path inserts, replacements and deletions before the next tool call; rebuild preserves hits", async () => {
    await write("main", "rhododendron-map.md", "Café cobalt orchid plans.");
    await sync();
    expect((await search("cafe cobalt")).results).toMatchObject([
      { path: "memory/rhododendron-map.md", snippet: "Café cobalt orchid plans." },
    ]);
    expect((await search("rhododendron-map")).results.map((hit) => hit.path)).toEqual([
      "memory/rhododendron-map.md",
    ]);
    await write("main", "rhododendron-map.md", "Saffron replacement is published.");
    await sync();
    expect((await search("cobalt")).results).toEqual([]);
    expect((await search("saffron")).results.map((hit) => hit.path)).toEqual([
      "memory/rhododendron-map.md",
    ]);
    await sync("main", true);
    expect((await search("saffron")).results.map((hit) => hit.path)).toEqual([
      "memory/rhododendron-map.md",
    ]);
    await fs.unlink(path.join(workspaces.get("main")!, "memory", "rhododendron-map.md"));
    invalidate("main", path.join(workspaces.get("main")!, "memory", "rhododendron-map.md"));
    await sync();
    expect((await search("saffron")).results).toEqual([]);
    expect((await search("rhododendron-map")).results).toEqual([]);
  });

  it("scopes lexical memory and transcript corpora and agents before a one-result limit", async () => {
    await write("main", "source-target.md", "sourcefilter gemstone");
    await write("other", "agent-decoy.md", "sourcefilter sourcefilter sourcefilter gemstone");
    await transcript("main", "source-decoy", "sourcefilter sourcefilter sourcefilter gemstone");
    await sync();
    await sync("other");
    expect(
      (await search("sourcefilter", { maxResults: 1 })).results.map((hit) => hit.path),
    ).toEqual(["memory/source-target.md"]);
    expect(
      (await search("sourcefilter", { corpus: "sessions", maxResults: 1 })).results.map(
        (hit) => hit.path,
      ),
    ).toEqual(["sessions/main/source-decoy.jsonl"]);
    expect(
      (await search("sourcefilter", { agentId: "other", maxResults: 1 })).results.map(
        (hit) => hit.path,
      ),
    ).toEqual(["memory/agent-decoy.md"]);
  });

  it("publishes vector updates, rebuilds and deletions through scoped public retrieval", async () => {
    await write("semantic", "target.md", "launch plan");
    await write("semantic", "orthogonal.md", "unrelated material");
    await transcript("semantic", "nearest-decoy", "nearest-decoy");
    await sync("semantic");
    const result = await search("semantic-only", { agentId: "semantic", maxResults: 1 });
    expect(result.results).toMatchObject([
      { path: "memory/target.md", score: expect.closeTo(0.56, 5) },
    ]);
    expect(
      (await search("semantic-only", { agentId: "semantic", corpus: "sessions", maxResults: 1 }))
        .results,
    ).toMatchObject([
      // Session ranking applies age decay; exact cosine arithmetic has its own worker proof.
      { path: "sessions/semantic/nearest-decoy.jsonl", score: expect.closeTo(0.7, 3) },
    ]);
    await write("semantic", "target.md", "nearest-decoy replacement");
    await sync("semantic");
    const updated = [
      {
        path: "memory/target.md",
        snippet: "nearest-decoy replacement",
        score: expect.closeTo(0.7, 5),
      },
    ];
    expect(
      (await search("semantic-only", { agentId: "semantic", maxResults: 1 })).results,
    ).toMatchObject(updated);
    await sync("semantic", true);
    expect(
      (await search("semantic-only", { agentId: "semantic", maxResults: 1 })).results,
    ).toMatchObject(updated);
    const target = path.join(workspaces.get("semantic")!, "memory", "target.md");
    await fs.unlink(target);
    invalidate("semantic", target);
    await sync("semantic");
    expect(
      (await search("semantic-only", { agentId: "semantic", maxResults: 1 })).results,
    ).toMatchObject([{ path: "memory/orthogonal.md", score: 0 }]);
  });

  it("uses configured trigram body and path substring search at the public tool", async () => {
    await write("trigram", "rhododendron-notebook.md", "supercalifragilistic recorder");
    await sync("trigram");
    for (const query of ["fragilist", "dodend"]) {
      expect((await search(query, { agentId: "trigram" })).results.map((hit) => hit.path)).toEqual([
        "memory/rhododendron-notebook.md",
      ]);
    }
  });

  it("ranks nearby phrases and more matched terms first in the documented OR fallback", async () => {
    await write("main", "rank-phrase.md", "copper lantern");
    await write("main", "rank-scattered.md", `copper ${"filler ".repeat(30)}lantern`);
    await write("main", "rank-many.md", "cobalt ochre");
    await write("main", "rank-fewer.md", "cobalt filler");
    await sync();
    const phrase = await search("copper lantern");
    expect(phrase.results.map((hit) => hit.path)).toEqual([
      "memory/rank-phrase.md",
      "memory/rank-scattered.md",
    ]);
    expect(phrase.results[0]!.score).toBeGreaterThan(phrase.results[1]!.score);
    expect((await search("cobalt ochre absenttoken")).results.map((hit) => hit.path)).toEqual([
      "memory/rank-many.md",
      "memory/rank-fewer.md",
    ]);
  });

  it("keeps pathological text and snippets bounded at the public tool boundary", async () => {
    await write("main", "bounded.md", `boundedmarker ${"café unicode ".repeat(150)}`);
    await sync();
    const bounded = await search("boundedmarker", { maxResults: 1 });
    expect(bounded.results[0]!.snippet.length).toBeLessThanOrEqual(700);
    for (const query of ["() & | ! : * <-> \\", "日本語"]) {
      const result = await search(query);
      expect(result.results).toEqual([]);
      expect(result.error ?? "").not.toMatch(/syntax error|bind message|stack|SQLSTATE/i);
    }
    for (const query of [
      "x".repeat(4097),
      Array.from({ length: 129 }, (_, i) => `term${i}`).join(" "),
    ]) {
      const result = await search(query);
      expect(result.unavailable).toBe(true);
      expect(result.error).toMatch(/4096|128/);
    }
    await expect(search(" ")).rejects.toThrow(/query/);
  });

  it("caps the combined body and exact-path streams at 200 public results", async () => {
    await write("main", "capmarker.md", "An exact filename result without a matching body.");
    await write(
      "main",
      "cap-population.md",
      Array.from(
        { length: 205 },
        (_, index) => `capmarker ${index} ${"padding ".repeat(192)}`,
      ).join("\n"),
    );
    await sync();
    const result = await search("capmarker", { maxResults: 1_000_000 });
    expect(result.results).toHaveLength(200);
    expect(result.results[0]!.path).toBe("memory/capmarker.md");
  });
});
