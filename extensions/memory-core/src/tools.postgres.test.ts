import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./memory/index.js";
import * as memorySources from "./memory/manager-source-state.js";
import { postgresProductScope } from "./postgres-product.test-support.js";
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

const database = postgresProductScope("memory_product");
type Hit = { path: string; source: string; score: number; snippet: string };
type Result = { results: Hit[]; unavailable?: boolean; error?: string; action?: string };

describe.skipIf(!database.connection)("PostgreSQL memory_search product flows", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let config: OpenClawConfig;
  let run: ReturnType<typeof AsyncLocalStorage.snapshot>;
  const managers = new Map<string, MemorySearchManager>();
  const workspace = (id: string) => path.join(state.workspaceDir, id);
  const agent = (id: string, searchConfig?: NonNullable<OpenClawConfig["memory"]>["search"]) => ({
    workspace: workspace(id),
    ...(searchConfig ? { memory: { search: searchConfig } } : {}),
  });

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "memory-search-product-pg",
      layout: "state-only",
    });
    await configureMemoryCoreDreamingStateForTests();
    await database.connect();
    for (const id of ["main", "other", "semantic", "trigram"]) {
      await fs.mkdir(path.join(workspace(id), "memory"), { recursive: true });
    }
    config = {
      database: { engine: "postgres" },
      plugins: { enabled: false },
      tools: { sessions: { visibility: "agent" } },
      agents: {
        entries: {
          main: agent("main"),
          other: agent("other"),
          semantic: agent("semantic", {
            provider: "openai",
            model: "product-fixture",
            store: { vector: { enabled: true } },
          }),
          trigram: agent("trigram", { store: { fts: { tokenizer: "trigram" } } }),
        },
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
    run = database.select(() => AsyncLocalStorage.snapshot(), config);
  });

  afterAll(async () => {
    await run(async () => {
      await closeAllMemorySearchManagers();
      resetMemoryCoreDreamingStateForTests();
      await state.cleanup();
    });
    await database.close();
  });

  async function write(agentId: string, name: string, text: string) {
    const file = path.join(workspace(agentId), "memory", name);
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

  const sync = (agentId = "main", force = false) =>
    run(async () => {
      let manager = managers.get(agentId);
      if (!manager) {
        const result = await getMemorySearchManager({
          cfg: config,
          agentId,
          runInBackgroundContext: run,
        });
        assert(result.manager, result.error ?? "Expected memory manager");
        manager = result.manager;
        managers.set(agentId, manager);
      }
      assert(typeof manager.sync === "function", "Expected a memory indexing manager");
      await manager.sync({ reason: "cli", force });
      return manager;
    });

  const search = (
    query: string,
    options: { agentId?: string; corpus?: "memory" | "sessions"; maxResults?: number } = {},
  ) =>
    run(async () => {
      testing.resetMemorySearchToolCooldowns();
      const tool = createMemorySearchTool({
        config,
        agentId: options.agentId ?? "main",
        agentSessionKey: `agent:${options.agentId ?? "main"}:main`,
        runInBackgroundContext: run,
      });
      assert(tool, "Expected public memory_search tool");
      const result = await tool.execute("postgres-product-search", {
        query,
        corpus: options.corpus ?? "memory",
        maxResults: options.maxResults ?? 20,
      });
      return result.details as Result;
    });

  const transcript = (agentId: string, sessionId: string, text: string) =>
    run(async () => {
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

  const paths = async (query: string, options?: Parameters<typeof search>[1]) => {
    const result = await search(query, options);
    expect(result).not.toMatchObject({ unavailable: true });
    return result.results.map((hit) => hit.path);
  };
  const semantic = async (corpus: "memory" | "sessions" = "memory") =>
    (await search("semantic-only", { agentId: "semantic", corpus, maxResults: 1 })).results;

  it("publishes body and path inserts, replacements and deletions before the next tool call; rebuild preserves hits", async () => {
    await write("main", "rhododendron-map.md", "Café cobalt orchid plans.");
    await sync();
    expect((await search("cafe cobalt")).results).toMatchObject([
      { path: "memory/rhododendron-map.md", snippet: "Café cobalt orchid plans." },
    ]);
    expect(await paths("rhododendron-map")).toEqual(["memory/rhododendron-map.md"]);
    await write("main", "rhododendron-map.md", "Saffron replacement is published.");
    await sync();
    expect((await search("cobalt")).results).toEqual([]);
    expect(await paths("saffron")).toEqual(["memory/rhododendron-map.md"]);
    await sync("main", true);
    expect(await paths("saffron")).toEqual(["memory/rhododendron-map.md"]);
    await fs.unlink(path.join(workspace("main"), "memory", "rhododendron-map.md"));
    invalidate("main", path.join(workspace("main"), "memory", "rhododendron-map.md"));
    await sync();
    expect((await search("saffron")).results).toEqual([]);
    expect((await search("rhododendron-map")).results).toEqual([]);
  });

  it("scopes lexical memory and transcript corpora and agents before a one-result limit", async () => {
    await write("main", "source-target.md", "sourcefilter gemstone");
    await write("other", "agent-decoy.md", "sourcefilter sourcefilter sourcefilter gemstone");
    await transcript("main", "source-decoy", "sourcefilter sourcefilter sourcefilter gemstone");
    const manager = await sync();
    // A broad sync can join an in-flight memory-only watch pass. Explicitly queue
    // this transcript instead of depending on the background session debounce.
    await run(() =>
      manager.sync!({
        reason: "cli",
        sessions: [{ agentId: "main", sessionId: "source-decoy" }],
      }),
    );
    await sync("other");
    expect(await paths("sourcefilter", { maxResults: 1 })).toEqual(["memory/source-target.md"]);
    expect(await paths("sourcefilter", { corpus: "sessions", maxResults: 1 })).toEqual([
      "sessions/main/source-decoy.jsonl",
    ]);
    expect(await paths("sourcefilter", { agentId: "other", maxResults: 1 })).toEqual([
      "memory/agent-decoy.md",
    ]);
  });

  it("publishes vector updates, rebuilds and deletions through scoped public retrieval", async () => {
    await write("semantic", "target.md", "launch plan");
    await write("semantic", "orthogonal.md", "unrelated material");
    await transcript("semantic", "nearest-decoy", "nearest-decoy");
    await sync("semantic");
    expect(await semantic()).toMatchObject([
      { path: "memory/target.md", score: expect.closeTo(0.56, 5) },
    ]);
    expect(await semantic("sessions")).toMatchObject([
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
    expect(await semantic()).toMatchObject(updated);
    await sync("semantic", true);
    expect(await semantic()).toMatchObject(updated);
    const target = path.join(workspace("semantic"), "memory", "target.md");
    await fs.unlink(target);
    invalidate("semantic", target);
    await sync("semantic");
    expect(await semantic()).toMatchObject([{ path: "memory/orthogonal.md", score: 0 }]);
  });

  it("uses configured trigram body and path substring search at the public tool", async () => {
    await write("trigram", "rhododendron-notebook.md", "supercalifragilistic recorder");
    await sync("trigram");
    for (const query of ["fragilist", "dodend"]) {
      expect(await paths(query, { agentId: "trigram" })).toEqual([
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
    expect(await paths("cobalt ochre absenttoken")).toEqual([
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
    await sync();
    await write("main", "before-cap.md", "An earlier indexing generation.");
    const planned = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const replanned = Promise.withResolvers<void>();
    const publish = Promise.withResolvers<void>();
    const resolveEntries = memorySources.resolveMemorySourceFileEntries;
    // Hold an older, real file listing while the next generation's files arrive.
    const planning = vi
      .spyOn(memorySources, "resolveMemorySourceFileEntries")
      .mockImplementationOnce(async (params) => {
        const entries = await resolveEntries(params);
        planned.resolve();
        await resume.promise;
        return entries;
      })
      .mockImplementationOnce(async (params) => {
        const entries = await resolveEntries(params);
        replanned.resolve();
        await publish.promise;
        return entries;
      });
    const active = sync();
    void active.catch(() => undefined);
    try {
      await Promise.race([
        planned.promise,
        active.then(() => {
          throw new Error("Expected the active sync to reach file planning");
        }),
      ]);
      await write("main", "capmarker.md", "An exact filename result without a matching body.");
      await write(
        "main",
        "cap-population.md",
        Array.from(
          { length: 205 },
          (_, index) => `capmarker ${index} ${"padding ".repeat(192)}`,
        ).join("\n"),
      );
      const joined = [sync(), sync()];
      resume.resolve();
      // Every caller must join the newer pass, including callers resumed after
      // another waiter has already claimed that pass's sync slot.
      try {
        expect(
          await Promise.race([
            replanned.promise.then(() => "planned"),
            ...joined.map((pending) => pending.then(() => "completed")),
          ]),
        ).toBe("planned");
      } finally {
        publish.resolve();
        await Promise.all(joined);
      }
      const result = await search("capmarker", { maxResults: 1_000_000 });
      expect(
        result.results,
        JSON.stringify({ ...result, results: result.results.length }),
      ).toHaveLength(200);
      expect(result.results[0]!.path).toBe("memory/capmarker.md");
    } finally {
      resume.resolve();
      publish.resolve();
      try {
        await active;
      } finally {
        planning.mockRestore();
      }
    }
  });
});
