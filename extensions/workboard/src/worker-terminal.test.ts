import { describe, expect, it } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";
import { reconcileWorkboardRunEnd } from "./worker-terminal.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
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
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

async function createRunningCard(store: WorkboardStore, runId: string) {
  const card = await store.create({
    title: "Developer delivery",
    status: "running",
    sessionKey: `agent:developer:subagent:${runId}`,
    runId,
    execution: {
      id: `${runId}:execution`,
      kind: "agent-session",
      engine: "codex",
      mode: "autonomous",
      status: "running",
      model: "default",
      sessionKey: `agent:developer:subagent:${runId}`,
      runId,
      startedAt: 1,
      updatedAt: 1,
    },
  });
  await store.claim(card.id, { ownerId: "developer", token: `${runId}:token` });
  return card;
}

describe("reconcileWorkboardRunEnd", () => {
  it("blocks a normal exit that omitted lifecycle completion", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await createRunningCard(store, "run-normal");

    await reconcileWorkboardRunEnd({ store, event: { runId: "run-normal", outcome: "ok" } });

    const blocked = await store.get(card.id);
    expect(blocked).toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
      metadata: {
        comments: [expect.objectContaining({ body: expect.stringContaining("ended normally") })],
      },
    });
    expect(blocked?.metadata).not.toHaveProperty("claim");
  });

  it("records an abnormal exit as blocked with its error", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await createRunningCard(store, "run-error");

    await reconcileWorkboardRunEnd({
      store,
      event: { runId: "run-error", outcome: "error", error: "prerequisite missing from main" },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: {
        comments: [
          expect.objectContaining({
            body: expect.stringContaining("prerequisite missing from main"),
          }),
        ],
      },
    });
  });

  it.each(["review", "done", "blocked"] as const)(
    "preserves an explicit %s lifecycle result",
    async (status) => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await createRunningCard(store, `run-${status}`);
      if (status === "blocked") {
        await store.block(card.id, { reason: "Explicit blocker." }, null);
      } else {
        await store.complete(card.id, { status, summary: "Delivered." }, null);
      }

      await reconcileWorkboardRunEnd({
        store,
        event: { runId: `run-${status}`, outcome: status === "blocked" ? "error" : "ok" },
      });

      await expect(store.get(card.id)).resolves.toMatchObject({ status });
    },
  );
});
