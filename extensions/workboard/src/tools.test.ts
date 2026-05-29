import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { WorkboardStore, type WorkboardKeyedStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, Awaited<ReturnType<WorkboardKeyedStore["lookup"]>>>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("workboard tools", () => {
  it("lists, claims, heartbeats, and reads worker context", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const tools = createWorkboardTools({
      api,
      context: { agentId: "main", sessionKey: "session-1" } as never,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const store = keyed;
    await store.register("card-1", {
      version: 1,
      card: {
        id: "card-1",
        title: "Ship coordination",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await store.register("archived-1", {
      version: 1,
      card: {
        id: "archived-1",
        title: "Closed work",
        status: "done",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { archivedAt: 2 },
      },
    });

    const claimed = readPayload(
      await byName.get("workboard_claim")?.execute("call-1", { id: "card-1" }),
    );
    expect(claimed.card).toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "main", token: "[redacted]" } },
    });
    const token = (claimed.token as string | undefined) ?? "";

    const heartbeat = readPayload(
      await byName
        .get("workboard_heartbeat")
        ?.execute("call-2", { id: "card-1", token, note: "alive" }),
    );
    expect(heartbeat).toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "alive" })] },
    });

    const read = readPayload(
      await byName.get("workboard_read")?.execute("call-3", { id: "card-1" }),
    );
    expect(read.workerContext).toContain("Ship coordination");
    expect(read.card).toMatchObject({ metadata: { claim: { token: "[redacted]" } } });

    const released = readPayload(
      await byName
        .get("workboard_release")
        ?.execute("call-4", { id: "card-1", token, status: "review" }),
    );
    expect(released).toMatchObject({ status: "review" });
    expect((released.metadata as { claim?: unknown } | undefined)?.claim).toBeUndefined();

    const list = readPayload(await byName.get("workboard_list")?.execute("call-5", {}));
    expect(list.cards).toEqual([expect.objectContaining({ id: "card-1" })]);
    const archivedList = readPayload(
      await byName.get("workboard_list")?.execute("call-6", { includeArchived: true }),
    );
    expect(archivedList.cards).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "archived-1", archivedAt: 2 })]),
    );
  });

  it("can share one store across tool instances for claim coordination", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const mainTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "other" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({ title: "Single owner" });

    await mainTools.get("workboard_claim")?.execute("call-1", { id: card.id });

    await expect(
      otherTools.get("workboard_claim")?.execute("call-2", { id: card.id }),
    ).rejects.toThrow(/already claimed/);
  });
});
