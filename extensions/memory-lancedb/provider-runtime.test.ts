import * as lancedb from "@lancedb/lancedb";
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { memoryConfigSchema } from "./config.js";
import { isMemoryRecallTimeoutError } from "./embeddings.js";
import { MemoryDB } from "./lancedb-store.js";
import {
  createEmbeddingHealthTracker,
  createLanceDbMemoryProviderRuntime,
  type LanceDbMemoryProviderDeps,
} from "./provider-runtime.js";
import { installTmpDirHarness } from "./test-helpers.js";

type OpenParams = Parameters<NonNullable<MemoryPluginCapability["providerRuntime"]>["open"]>[0];
type Authority = OpenParams["context"]["authority"];
const OPERATOR: Authority = { kind: "operator", scopes: ["operator.read"] };
const ownerSession = (agentId = "alpha"): Authority => ({
  kind: "session",
  sessionKey: `agent:${agentId}:main`,
  sandboxed: false,
  audience: { kind: "owner-private", agentId },
});
const reference = (id: string) => ({ providerId: "memory-lancedb", id });

describe("memory-lancedb provider runtime", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-provider-" });
  const databases: MemoryDB[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });
  function createHarness(overrides: Partial<LanceDbMemoryProviderDeps> = {}) {
    const db = new MemoryDB(getDbPath(), 2);
    databases.push(db);
    const config = memoryConfigSchema.parse({
      embedding: { model: "text-embedding-3-small" },
      dbPath: getDbPath(),
    });
    const embed = vi.fn(async () => [1, 0]);
    const tracked = createEmbeddingHealthTracker({ embed });
    const cooldowns = new Map<string, { error: string }>();
    const runtime = createLanceDbMemoryProviderRuntime({
      providerId: "memory-lancedb",
      db,
      embeddings: tracked.embeddings,
      resolveCurrentConfig: () => config,
      resolveEnabledAgentId: (id) => id?.trim().toLowerCase(),
      countMemories: async (id) => (await db.query(id, { columns: ["id"] })).length,
      lastEmbeddingFailure: tracked.lastFailure,
      readRecallCooldown: (id) => cooldowns.get(id),
      recordRecallCooldown: (id, error) => {
        cooldowns.set(id, { error });
      },
      isRecallTimeoutError: isMemoryRecallTimeoutError,
      logger: { warn: vi.fn() },
      ...overrides,
    });
    const seed = (text = "alpha prefers tea\nsecond line", agentId = "alpha", vector = [1, 0]) =>
      db.store(agentId, { text, vector, importance: 0.8, category: "preference" });
    const open = async (authority = OPERATOR, assertCurrent = () => {}) => {
      const result = await runtime.open({
        cfg: {},
        agentId: "alpha",
        purpose: "status",
        context: { authority, assertCurrent },
      });
      if (!result.provider) {
        throw new Error(result.error);
      }
      return result.provider;
    };
    return { db, embed, seed, open, runtime };
  }

  test.each([OPERATOR, ownerSession()])(
    "serves scoped search, retrieval and health to $kind",
    async (authority) => {
      const { seed, open, embed } = createHarness();
      const alpha = await seed();
      const beta = await seed("beta secret", "beta");
      await seed("far", "alpha", [0, 9]);
      let provider = await open(authority);
      const page = await provider.search({ query: "tea", minScore: 0.9 });
      expect(page).toMatchObject({
        coverage: "complete",
        hits: [{ reference: reference(alpha.id), excerpt: alpha.text, source: "memory" }],
      });
      expect(page.hits).toHaveLength(1);
      expect(page.hits[0]?.automaticRecall).toBeUndefined();
      expect(
        (await provider.search({ query: "tea", minScore: 0, maxResults: 1 })).hits,
      ).toHaveLength(1);
      await provider.close();
      provider = await open(authority);
      await expect(provider.get({ reference: reference(alpha.id) })).resolves.toMatchObject({
        status: "ok",
        text: alpha.text,
      });
      await expect(
        provider.get({ reference: reference(alpha.id), from: 2, lines: 1 }),
      ).resolves.toMatchObject({ status: "ok", text: "second line", from: 2, lines: 1 });
      for (const ref of [
        reference(beta.id),
        { ...reference(alpha.id), revision: "r1" },
        reference("MEMORY.md"),
      ]) {
        await expect(provider.get({ reference: ref })).resolves.toEqual({ status: "not_found" });
      }
      embed.mockClear();
      const health = await provider.health();
      expect(health).toMatchObject({
        status: "ready",
        details: {
          backend: "lancedb",
          memories: 2,
          embedding: { provider: "openai", model: "text-embedding-3-small" },
        },
      });
      expect(JSON.stringify(health)).not.toContain(getDbPath());
      expect(JSON.stringify(health)).not.toContain(alpha.text);
      expect(embed).not.toHaveBeenCalled();
    },
  );

  test.each<Authority>([
    { kind: "session", sessionKey: "s", sandboxed: false },
    {
      kind: "session",
      sessionKey: "group",
      sandboxed: false,
      audience: {
        kind: "conversation",
        agentId: "alpha",
        sessionKey: "group",
        sessionId: "00000000-0000-4000-8000-000000000000",
      },
    },
    ownerSession("beta"),
    { kind: "host", operation: "status" },
  ])("denies $kind content before embedding but serves redacted health", async (authority) => {
    const { seed, open, embed, db } = createHarness();
    const entry = await seed();
    const search = vi.spyOn(db, "search");
    const query = vi.spyOn(db, "query");
    const provider = await open(authority);
    await expect(provider.search({ query: "tea" })).resolves.toMatchObject({
      hits: [],
      warning: expect.stringContaining("stored memories were not searched"),
    });
    await expect(provider.get({ reference: reference(entry.id) })).rejects.toThrow(
      "memory access denied",
    );
    expect(embed).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    const health = await provider.health();
    expect(health.status).toBe("ready");
    expect(health.details).not.toHaveProperty("memories");
    expect(JSON.stringify(health)).not.toContain(entry.text);
  });

  test("redacts embedding failures from every caller's health and recovers", async () => {
    const warn = vi.fn();
    const { seed, embed, open } = createHarness({ logger: { warn } });
    await seed("kept");
    const provider = await open();
    const error = `No API key found. Auth store: ${getDbPath()}/auth-profiles.json (agentDir: ${getDbPath()}).`;
    embed.mockRejectedValueOnce(new Error(error));
    await expect(provider.search({ query: "tea" })).rejects.toThrow(
      "memory search embedding failed",
    );
    for (const caller of [provider, await open({ kind: "host", operation: "status" })]) {
      const health = await caller.health();
      expect(health.status).toBe("degraded");
      for (const privateText of [getDbPath(), "Auth store", "agentDir"]) {
        expect(JSON.stringify(health)).not.toContain(privateText);
      }
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(error));
    await expect(provider.search({ query: "tea" })).resolves.toMatchObject({
      hits: [{ excerpt: "kept" }],
    });
    expect((await provider.health()).status).toBe("ready");
  });

  test.each([
    { fails: false, revoked: true },
    { fails: true, revoked: true },
    { fails: true, revoked: false },
  ])(
    "revalidates and redacts health (fails=$fails, revoked=$revoked)",
    async ({ fails, revoked }) => {
      let current = true;
      const warn = vi.fn();
      const { open } = createHarness({
        countMemories: async () => {
          current = !revoked;
          if (fails) {
            throw new Error(getDbPath());
          }
          return 1;
        },
        logger: { warn },
      });
      const provider = await open(OPERATOR, () => {
        if (!current) {
          throw new Error("revoked");
        }
      });
      if (revoked) {
        await expect(provider.health()).rejects.toThrow("revoked");
        return;
      }
      const health = await provider.health();
      expect(health.status).toBe("unavailable");
      expect(JSON.stringify(health)).not.toContain(getDbPath());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(getDbPath()));
    },
  );

  test.each(["embedding", "schema", "checkoutLatest"] as const)(
    "does not dispatch stale reads after awaited %s",
    async (preparation) => {
      const { seed, open, db, embed } = createHarness();
      const entry = await seed();
      const connection = await lancedb.connect(getDbPath());
      const probe = await connection.openTable("memories");
      const prototype = Object.getPrototypeOf(probe) as lancedb.Table;
      probe.close();
      connection.close();
      const prepare = preparation === "embedding" ? embed : vi.spyOn(prototype, preparation);
      const search = vi.spyOn(db, "search");
      const query = vi.spyOn(prototype, "query");
      const vectorSearch = vi.spyOn(prototype, "vectorSearch");
      const provider = await open(ownerSession(), () => {
        if (prepare.mock.calls.length) {
          throw new Error("revoked");
        }
      });
      for (const read of [
        () => provider.search({ query: "tea" }),
        ...(preparation === "embedding"
          ? []
          : [() => provider.get({ reference: reference(entry.id) })]),
      ]) {
        await db.close();
        db.start();
        if (preparation === "checkoutLatest") {
          await db.query("alpha", { columns: ["id"] });
        }
        prepare.mockClear();
        query.mockClear();
        vectorSearch.mockClear();
        await expect(read()).rejects.toThrow("revoked");
        expect(prepare).toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(vectorSearch).not.toHaveBeenCalled();
        if (preparation === "embedding") {
          expect(search).not.toHaveBeenCalled();
        }
      }
    },
  );

  test("does not open or retain reads for a disabled agent", async () => {
    let enabled = true;
    const { open, runtime, embed } = createHarness({
      resolveEnabledAgentId: () => (enabled ? "alpha" : undefined),
    });
    const provider = await open();
    enabled = false;
    await expect(provider.search({ query: "tea" })).rejects.toThrow("Memory is disabled");
    expect(embed).not.toHaveBeenCalled();
    await expect(
      runtime.open({
        cfg: {},
        agentId: "alpha",
        context: { authority: OPERATOR, assertCurrent() {} },
      }),
    ).resolves.toEqual({ provider: null, error: "Memory is disabled for this agent." });
  });
});
