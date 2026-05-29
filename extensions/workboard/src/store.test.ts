import { describe, expect, it } from "vitest";
import { WorkboardStore, type WorkboardKeyedStore } from "./store.js";

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

describe("WorkboardStore", () => {
  it("creates and lists cards by status order and position", async () => {
    const store = new WorkboardStore(createMemoryStore());

    const review = await store.create({
      title: "Review release notes",
      status: "review",
      priority: "high",
      labels: "release, docs",
    });
    const todo = await store.create({ title: "Fix dashboard copy", status: "todo" });

    expect((await store.list()).map((card) => card.id)).toEqual([todo.id, review.id]);
    expect(review.labels).toEqual(["release", "docs"]);
    expect(review.priority).toBe("high");
    expect(review.events?.[0]).toMatchObject({ kind: "created", toStatus: "review" });
  });

  it("does not persist empty metadata for default cards", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);

    const card = await store.create({ title: "Plain card" });

    expect(card.metadata).toBeUndefined();
    const entry = await keyed.lookup(card.id);
    expect(Object.hasOwn(entry?.card ?? {}, "metadata")).toBe(false);
  });

  it("preserves explicit zero positions", async () => {
    const store = new WorkboardStore(createMemoryStore());

    const card = await store.create({ title: "Top card", status: "todo", position: 0 });

    expect(card.position).toBe(0);
  });

  it("keeps initial session, run, and task links when creating cards", async () => {
    const store = new WorkboardStore(createMemoryStore());

    const card = await store.create({
      title: "Follow up",
      sessionKey: "agent:main:dashboard:1",
      runId: "run-1",
      taskId: "task-1",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "claude",
        mode: "manual",
        status: "running",
        model: "anthropic/claude-sonnet-4-6",
        sessionKey: "agent:main:dashboard:1",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    expect(card).toMatchObject({
      sessionKey: "agent:main:dashboard:1",
      runId: "run-1",
      taskId: "task-1",
      execution: {
        engine: "claude",
        mode: "manual",
        model: "anthropic/claude-sonnet-4-6",
      },
      metadata: {
        attempts: [
          expect.objectContaining({
            id: "agent:main:dashboard:1",
            status: "running",
            engine: "claude",
            mode: "manual",
            sessionKey: "agent:main:dashboard:1",
            startedAt: 10,
          }),
        ],
      },
    });
  });

  it("stores card templates and metadata in the card record", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);

    const card = await store.create({
      title: "Fix flaky lane",
      templateId: "bugfix",
      metadata: {
        comments: [{ id: "comment-1", body: "Seen twice", createdAt: 10 }],
        links: [{ id: "link-1", type: "blocks", targetCardId: "card-2", createdAt: 11 }],
        proof: [{ id: "proof-1", status: "passed", command: "pnpm test", createdAt: 12 }],
      },
    });

    await expect(keyed.lookup(card.id)).resolves.toMatchObject({
      version: 1,
      card: {
        metadata: {
          templateId: "bugfix",
          comments: [expect.objectContaining({ body: "Seen twice" })],
          links: [expect.objectContaining({ type: "blocks", targetCardId: "card-2" })],
          proof: [expect.objectContaining({ status: "passed", command: "pnpm test" })],
        },
      },
    });
  });

  it("moves cards and records lifecycle timestamps", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Ship workboard" });

    const running = await store.move(card.id, "running", 500);
    expect(running.status).toBe("running");
    expect(running.position).toBe(500);
    expect(running.startedAt).toBeGreaterThanOrEqual(card.createdAt);
    expect(running.events?.at(-1)).toMatchObject({
      kind: "moved",
      fromStatus: "todo",
      toStatus: "running",
    });

    const done = await store.update(card.id, { status: "done" });
    expect(done.completedAt).toBeGreaterThanOrEqual(done.startedAt ?? 0);
  });

  it("keeps execution session links aligned with edited card links", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Relink me",
      sessionKey: "agent:main:dashboard:1",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const relinked = await store.update(card.id, { sessionKey: "agent:main:dashboard:2" });
    expect(relinked.sessionKey).toBe("agent:main:dashboard:2");
    expect(relinked.execution?.sessionKey).toBe("agent:main:dashboard:2");
    expect(relinked.events?.at(-1)).toMatchObject({
      kind: "linked",
      sessionKey: "agent:main:dashboard:2",
    });

    const unlinked = await store.update(card.id, { sessionKey: "" });
    expect(unlinked.sessionKey).toBeUndefined();
    expect(unlinked.execution?.sessionKey).toBeUndefined();

    const cleared = await store.update(card.id, { execution: null });
    expect(cleared.execution).toBeUndefined();
  });

  it("tracks execution attempts as card metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Run worker" });

    const running = await store.update(card.id, {
      status: "running",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        startedAt: 10,
        updatedAt: 10,
      },
    });
    expect(running.metadata?.attempts).toEqual([
      expect.objectContaining({
        id: "run-1",
        status: "running",
        engine: "codex",
        runId: "run-1",
      }),
    ]);
    expect(running.events?.at(-1)).toMatchObject({ kind: "moved" });

    const blocked = await store.update(card.id, {
      execution: {
        ...running.execution!,
        status: "blocked",
        updatedAt: 20,
      },
    });

    expect(blocked.metadata?.attempts?.[0]).toMatchObject({
      status: "blocked",
      endedAt: 20,
    });
    expect(blocked.metadata?.failureCount).toBe(1);
    expect(blocked.events?.at(-1)).toMatchObject({ kind: "attempt_updated", runId: "run-1" });

    const commented = await store.addComment(card.id, { body: "Need provider follow-up." });
    expect(commented.metadata?.failureCount).toBe(1);
    expect(commented.metadata?.attempts?.[0]).toMatchObject({
      status: "blocked",
      endedAt: 20,
    });

    const retrying = await store.update(card.id, {
      execution: {
        ...running.execution!,
        id: "exec-2",
        runId: "run-2",
        status: "running",
        startedAt: 30,
        updatedAt: 30,
      },
    });
    expect(retrying.metadata?.failureCount).toBe(1);
    expect(retrying.metadata?.attempts?.[1]).toMatchObject({
      id: "run-2",
      startedAt: 30,
      status: "running",
    });

    const blockedAgain = await store.update(card.id, {
      execution: {
        ...retrying.execution!,
        status: "blocked",
        updatedAt: 40,
      },
    });
    expect(blockedAgain.metadata?.failureCount).toBe(2);
  });

  it("adds comments, links, proof, and archive metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Track proof" });

    const commented = await store.addComment(card.id, { body: "Reviewer asked for screenshots." });
    expect(commented.metadata?.comments?.[0]).toMatchObject({
      body: "Reviewer asked for screenshots.",
    });
    expect(commented.events?.at(-1)).toMatchObject({ kind: "comment_added" });

    const linked = await store.addLink(card.id, {
      type: "blocked_by",
      targetCardId: "card-upstream",
      title: "Upstream fix",
    });
    expect(linked.metadata?.links?.[0]).toMatchObject({
      type: "blocked_by",
      targetCardId: "card-upstream",
    });
    expect(linked.events?.at(-1)).toMatchObject({ kind: "link_added" });

    const proven = await store.addProof(card.id, {
      status: "passed",
      command: "pnpm test extensions/workboard",
    });
    expect(proven.metadata?.proof?.[0]).toMatchObject({
      status: "passed",
      command: "pnpm test extensions/workboard",
    });
    expect(proven.events?.at(-1)).toMatchObject({ kind: "proof_added" });

    const archived = await store.archive(card.id, true);
    expect(archived.metadata?.archivedAt).toBeGreaterThan(0);
    expect(archived.events?.at(-1)).toMatchObject({ kind: "archived" });

    const restored = await store.archive(card.id, false);
    expect(restored.metadata?.archivedAt).toBeUndefined();
    expect(restored.events?.at(-1)).toMatchObject({ kind: "unarchived" });
  });

  it("keeps concurrent metadata appends from dropping siblings", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Collect notes" });

    await Promise.all([
      store.addComment(card.id, { body: "First note." }),
      store.addComment(card.id, { body: "Second note." }),
    ]);

    const saved = await store.get(card.id);
    expect(saved?.metadata?.comments?.map((comment) => comment.body).toSorted()).toEqual([
      "First note.",
      "Second note.",
    ]);
  });

  it("keeps metadata under the keyed-store value budget", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Collect a lot of notes" });

    for (let index = 0; index < 50; index += 1) {
      await store.addComment(card.id, {
        body: `${String(index).padStart(2, "0")} ${"x".repeat(1990)}`,
      });
    }

    const saved = await store.get(card.id);
    expect(Buffer.byteLength(JSON.stringify(saved?.metadata), "utf8")).toBeLessThanOrEqual(
      24 * 1024,
    );
    expect(saved?.metadata?.comments?.at(-1)?.body).toContain("49 ");
    expect(saved?.metadata?.comments?.length).toBeLessThan(50);
  });

  it("records append events when metadata retention drops old comments", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Track retained comments" });

    let updated = card;
    for (let index = 0; index < 51; index += 1) {
      updated = await store.addComment(card.id, { body: `Note ${index}` });
    }

    expect(updated.metadata?.comments).toHaveLength(50);
    expect(updated.metadata?.comments?.at(0)?.body).toBe("Note 1");
    expect(updated.events?.at(-1)).toMatchObject({ kind: "comment_added" });
  });

  it("keeps queued metadata when lifecycle updates add stale state", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Sync stale state" });

    await Promise.all([
      store.update(card.id, {
        status: "running",
        metadata: {
          stale: {
            detectedAt: 10,
            lastSessionUpdatedAt: 1,
            reason: "Linked session has not reported recent activity.",
          },
        },
      }),
      store.addComment(card.id, { body: "Operator note." }),
    ]);

    const saved = await store.get(card.id);
    expect(saved?.status).toBe("running");
    expect(saved?.metadata?.stale?.lastSessionUpdatedAt).toBe(1);
    expect(saved?.metadata?.comments?.map((comment) => comment.body)).toContain("Operator note.");
  });

  it("exports card records with metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Export me", templateId: "docs" });

    await expect(store.exportCards()).resolves.toMatchObject({
      cards: [expect.objectContaining({ id: card.id, metadata: { templateId: "docs" } })],
      exportedAt: expect.any(Number),
    });
  });

  it("rejects invalid status values", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await expect(store.create({ title: "Bad card", status: "later" })).rejects.toThrow(
      /status must be one of/,
    );
  });
});
