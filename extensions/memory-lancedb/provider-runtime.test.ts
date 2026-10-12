import * as lancedb from "@lancedb/lancedb";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import { describe, expect, test, vi } from "vitest";
import { memoryConfigSchema } from "./config.js";
import { isMemoryRecallTimeoutError } from "./embeddings.js";
import { MemoryDB } from "./lancedb-store.js";
import {
  createEmbeddingHealthTracker,
  createLanceDbMemoryProviderRuntime,
  type LanceDbMemoryProviderDeps,
} from "./provider-runtime.js";
import { installTmpDirHarness } from "./test-helpers.js";

type MemoryProviderRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
type OpenParams = Parameters<MemoryProviderRuntime["open"]>[0];
type Authority = OpenParams["context"]["authority"];

const PROVIDER_ID = "memory-lancedb";
const OPERATOR: Authority = { kind: "operator", scopes: ["operator.read"] };
const ownerSession = (agentId: string): Authority => ({
  kind: "session",
  sessionKey: `agent:${agentId}:main`,
  sandboxed: false,
  audience: { kind: "owner-private", agentId },
});

describe("memory-lancedb provider runtime", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-provider-" });

  function createHarness(overrides: Partial<LanceDbMemoryProviderDeps> = {}) {
    const db = new MemoryDB(getDbPath(), 2);
    const config = memoryConfigSchema.parse({
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      dbPath: getDbPath(),
    });
    const vectors = new Map<string, number[]>();
    const embed = vi.fn(async (_agentId: string, text: string) => vectors.get(text) ?? [1, 0]);
    const tracked = createEmbeddingHealthTracker({ embed });
    const cooldowns = new Map<string, { error: string }>();
    const runtime = createLanceDbMemoryProviderRuntime({
      providerId: PROVIDER_ID,
      db,
      embeddings: tracked.embeddings,
      resolveCurrentConfig: () => config,
      resolveEnabledAgentId: (rawAgentId) => rawAgentId?.trim().toLowerCase() || undefined,
      countMemories: async (agentId) => (await db.query(agentId, { columns: ["id"] })).length,
      lastEmbeddingFailure: tracked.lastFailure,
      readRecallCooldown: (agentId) => cooldowns.get(agentId),
      recordRecallCooldown: (agentId, error) => {
        cooldowns.set(agentId, { error });
      },
      isRecallTimeoutError: isMemoryRecallTimeoutError,
      logger: { warn: vi.fn() },
      ...overrides,
    });
    const open = async (
      agentId: string,
      authority: Authority,
      assertCurrent: () => void = () => {},
    ) => {
      const result = await runtime.open({
        cfg: {} as OpenClawConfig,
        agentId,
        purpose: "status",
        context: { authority, assertCurrent },
      });
      if (!result.provider) {
        throw new Error(result.error ?? "provider did not open");
      }
      return result.provider;
    };
    return { db, embed, vectors, tracked, cooldowns, runtime, open };
  }

  test("searches and fetches only the opened agent's memories", async () => {
    const { db, open, vectors } = createHarness();
    try {
      const alpha = await db.store("alpha", {
        text: "alpha prefers tea\nsecond line",
        vector: [1, 0],
        importance: 0.8,
        category: "preference",
      });
      const beta = await db.store("beta", {
        text: "beta prefers coffee",
        vector: [1, 0],
        importance: 0.8,
        category: "preference",
      });
      vectors.set("what does alpha drink", [1, 0]);

      const provider = await open("alpha", OPERATOR);
      expect(provider.capabilities).toEqual({
        sources: ["memory"],
        pagination: false,
        candidates: [],
        projectFilter: false,
      });

      const page = await provider.search({ query: "what does alpha drink" });
      expect(page.coverage).toBe("complete");
      expect(page.hits).toHaveLength(1);
      expect(page.hits[0]).toMatchObject({
        reference: { providerId: PROVIDER_ID, id: alpha.id },
        excerpt: "alpha prefers tea\nsecond line",
        source: "memory",
      });
      // Stored rows never opt into host-driven automatic injection.
      expect(page.hits[0]?.automaticRecall).toBeUndefined();

      await expect(
        provider.get({ reference: { providerId: PROVIDER_ID, id: alpha.id } }),
      ).resolves.toMatchObject({ status: "ok", text: "alpha prefers tea\nsecond line" });
      await expect(
        provider.get({ reference: { providerId: PROVIDER_ID, id: alpha.id }, from: 2, lines: 1 }),
      ).resolves.toMatchObject({ status: "ok", text: "second line", from: 2, lines: 1 });
      await expect(
        provider.get({ reference: { providerId: PROVIDER_ID, id: beta.id } }),
      ).resolves.toEqual({ status: "not_found" });
      await expect(
        provider.get({ reference: { providerId: PROVIDER_ID, id: alpha.id, revision: "r1" } }),
      ).resolves.toEqual({ status: "not_found" });
      await expect(
        provider.get({ reference: { providerId: PROVIDER_ID, id: "MEMORY.md" } }),
      ).resolves.toEqual({ status: "not_found" });
    } finally {
      db.close();
    }
  });

  test("enforces the requested minimum score and result limit", async () => {
    const { db, open, vectors } = createHarness();
    try {
      await db.store("alpha", { text: "near", vector: [1, 0], importance: 0.5, category: "fact" });
      await db.store("alpha", { text: "far", vector: [0, 9], importance: 0.5, category: "fact" });
      vectors.set("q", [1, 0]);
      const provider = await open("alpha", OPERATOR);

      const strict = await provider.search({ query: "q", minScore: 0.9 });
      expect(strict.hits.map((hit) => hit.excerpt)).toEqual(["near"]);
      const limited = await provider.search({ query: "q", minScore: 0, maxResults: 1 });
      expect(limited.hits.map((hit) => hit.excerpt)).toEqual(["near"]);
    } finally {
      db.close();
    }
  });

  test.each<[string, Authority]>([
    ["a session without an audience", { kind: "session", sessionKey: "s", sandboxed: false }],
    [
      "a conversation audience",
      {
        kind: "session",
        sessionKey: "agent:alpha:group",
        sandboxed: false,
        audience: {
          kind: "conversation",
          agentId: "alpha",
          sessionKey: "agent:alpha:group",
          sessionId: "00000000-0000-4000-8000-000000000000",
        },
      },
    ],
    ["another agent's owner audience", ownerSession("beta")],
    ["a host operation", { kind: "host", operation: "status" }],
  ])("withholds memories from %s but still reports health", async (_label, authority) => {
    const { db, embed, open } = createHarness();
    try {
      const stored = await db.store("alpha", {
        text: "alpha private preference",
        vector: [1, 0],
        importance: 0.8,
        category: "preference",
      });
      const provider = await open("alpha", authority);

      // Search yields nothing rather than failing the consumer; a direct fetch is refused.
      const denied = await provider.search({ query: "preference" });
      expect(denied.hits).toEqual([]);
      expect(denied.warning).toContain("stored memories were not searched");
      await expect(
        provider.get({ reference: { providerId: PROVIDER_ID, id: stored.id } }),
      ).rejects.toThrow("memory access denied");
      expect(embed).not.toHaveBeenCalled();

      const health = await provider.health();
      expect(health.status).toBe("ready");
      // A caller that cannot read the partition does not learn its size either.
      expect(health.details).not.toHaveProperty("memories");
      expect(JSON.stringify(health)).not.toContain("alpha private preference");
    } finally {
      db.close();
    }
  });

  test("lets the agent owner's private session read its memories", async () => {
    const { db, open } = createHarness();
    try {
      await db.store("alpha", {
        text: "alpha private preference",
        vector: [1, 0],
        importance: 0.8,
        category: "preference",
      });
      const provider = await open("alpha", ownerSession("alpha"));
      const page = await provider.search({ query: "preference" });
      expect(page.hits.map((hit) => hit.excerpt)).toEqual(["alpha private preference"]);
    } finally {
      db.close();
    }
  });

  test("reports health from the real store without paths or memory text", async () => {
    const { db, open } = createHarness();
    try {
      await db.store("alpha", {
        text: "alpha private preference",
        vector: [1, 0],
        importance: 0.8,
        category: "preference",
      });
      await db.store("beta", { text: "other", vector: [1, 0], importance: 0.5, category: "fact" });
      const provider = await open("alpha", OPERATOR);

      const health = await provider.health();
      expect(health).toEqual({
        status: "ready",
        details: {
          backend: "lancedb",
          embedding: { provider: "openai", model: "text-embedding-3-small" },
          autoCapture: false,
          autoRecall: true,
          memories: 1,
        },
      });
      const serialized = JSON.stringify(health);
      expect(serialized).not.toContain(getDbPath());
      expect(serialized).not.toContain("alpha private preference");
    } finally {
      db.close();
    }
  });

  test("turns an embedding failure into a search error and degraded health", async () => {
    const warn = vi.fn();
    const { db, embed, open } = createHarness({ logger: { warn } });
    try {
      await db.store("alpha", { text: "kept", vector: [1, 0], importance: 0.5, category: "fact" });
      const provider = await open("alpha", OPERATOR);

      // Shape of the host's missing-provider-auth error, which names both locations.
      const error = `No API key found for provider "openai". Auth store: ${getDbPath()}/auth-profiles.json (agentDir: ${getDbPath()}).`;
      embed.mockRejectedValueOnce(new Error(error));
      await expect(provider.search({ query: "anything" })).rejects.toThrow(
        'memory search embedding failed: No API key found for provider "openai"',
      );
      const degraded = await provider.health();
      expect(degraded.status).toBe("degraded");
      expect(degraded.message).toBe(
        "The last memory embedding request failed. Check the Gateway log. If credential resolution failed, run openclaw secrets reload, then retry memory search.",
      );
      expect(degraded.details).toMatchObject({ memories: 1 });
      const deniedSession = await open("alpha", {
        kind: "session",
        sessionKey: "s",
        sandboxed: false,
      });
      const deniedHealth = await deniedSession.health();
      expect(deniedHealth.status).toBe("degraded");
      for (const health of [degraded, deniedHealth]) {
        const serialized = JSON.stringify(health);
        expect(serialized).not.toContain(getDbPath());
        expect(serialized).not.toContain("Auth store");
        expect(serialized).not.toContain("agentDir");
      }
      expect(deniedHealth.details).not.toHaveProperty("memories");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(error));

      // The next successful embedding clears the recorded failure.
      await expect(provider.search({ query: "anything" })).resolves.toMatchObject({
        hits: [{ excerpt: "kept" }],
      });
      expect((await provider.health()).status).toBe("ready");
    } finally {
      db.close();
    }
  });

  test("reports an unreadable store as unavailable without leaking the error detail", async () => {
    const warn = vi.fn();
    const { db, open } = createHarness({
      countMemories: async () => {
        throw new Error(`cannot open ${getDbPath()}`);
      },
      logger: { warn },
    });
    try {
      const provider = await open("alpha", OPERATOR);
      const health = await provider.health();
      expect(health.status).toBe("unavailable");
      expect(JSON.stringify(health)).not.toContain(getDbPath());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(getDbPath()));
    } finally {
      db.close();
    }
  });

  test("does not read rows after the caller's authority lapses during embedding", async () => {
    const { db, embed, open } = createHarness();
    const search = vi.spyOn(db, "search");
    try {
      await db.store("alpha", { text: "kept", vector: [1, 0], importance: 0.5, category: "fact" });
      let current = true;
      const provider = await open("alpha", OPERATOR, () => {
        if (!current) {
          throw new Error("authority is no longer active");
        }
      });
      embed.mockImplementationOnce(async () => {
        current = false;
        return [1, 0];
      });

      await expect(provider.search({ query: "anything" })).rejects.toThrow(
        "authority is no longer active",
      );
      expect(search).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  // Revocation lands inside the store's own preparation await, after the provider's
  // pre-read check has already passed, on the real LanceDB table.
  test.each(["a retained table handle", "a first open"] as const)(
    "does not dispatch a read when the owner audience is revoked while the store prepares %s",
    async (preparation) => {
      const seed = new MemoryDB(getDbPath(), 2);
      const stored = await seed.store("alpha", {
        text: "alpha private preference",
        vector: [1, 0],
        importance: 0.8,
        category: "preference",
      });
      seed.close();
      const connection = await lancedb.connect(getDbPath());
      const probe = await connection.openTable("memories");
      const tablePrototype = Object.getPrototypeOf(probe) as lancedb.Table;
      probe.close();
      connection.close();

      const { db, open } = createHarness();
      const firstOpen = preparation === "a first open";
      try {
        // The audience counts as revoked from the moment the table's preparation call starts.
        const prepare = vi.spyOn(tablePrototype, firstOpen ? "schema" : "checkoutLatest");
        const vectorSearch = vi.spyOn(tablePrototype, "vectorSearch");
        const query = vi.spyOn(tablePrototype, "query");
        // The spies sit on the prototype the store's reads go through.
        await db.query("alpha", { columns: ["id"] });
        expect(query).toHaveBeenCalled();
        // Each read starts with live authority and the store in the state under test.
        const arrange = async () => {
          db.close();
          if (!firstOpen) {
            await db.query("alpha", { columns: ["id"] });
          }
          prepare.mockClear();
          query.mockClear();
        };
        const provider = await open("alpha", ownerSession("alpha"), () => {
          if (prepare.mock.calls.length > 0) {
            throw new Error("authority is no longer active");
          }
        });

        await arrange();
        await expect(provider.search({ query: "preference" })).rejects.toThrow(
          "authority is no longer active",
        );
        expect(prepare).toHaveBeenCalled();

        await arrange();
        await expect(
          provider.get({ reference: { providerId: PROVIDER_ID, id: stored.id } }),
        ).rejects.toThrow("authority is no longer active");
        expect(prepare).toHaveBeenCalled();

        expect(vectorSearch).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        db.close();
      }
    },
  );

  test("does not open a provider for an agent with memory disabled", async () => {
    const { db, runtime } = createHarness({ resolveEnabledAgentId: () => undefined });
    try {
      await expect(
        runtime.open({
          cfg: {} as OpenClawConfig,
          agentId: "alpha",
          context: { authority: OPERATOR, assertCurrent: () => {} },
        }),
      ).resolves.toEqual({ provider: null, error: "Memory is disabled for this agent." });
    } finally {
      db.close();
    }
  });
});
