import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import {
  CODEX_MANAGED_THREAD_MAX_ENTRIES,
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";

function createStateStore() {
  const values = new Map<string, StoredCodexManagedThread>();
  const state: Parameters<typeof createCodexManagedThreadStore>[0] = {
    async registerIfAbsent(key, value) {
      const inserted = !values.has(key);
      values.set(key, values.get(key) ?? value);
      return inserted;
    },
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
  const store = createCodexManagedThreadStore(state);
  const mark = (threadId = "thread", sourceHomeId = "home", rolloutPath?: string) =>
    store.mark({ sourceHomeId, threadId, ...(rolloutPath ? { rolloutPath } : {}) });
  return { state, values, store, mark };
}

describe("Codex managed thread store", () => {
  afterEach(() => vi.restoreAllMocks());
  it("records one durable ownership row per home and thread", async () => {
    const { values, store, mark } = createStateStore();
    const sourceHomeId = codexCatalogHomeId("/tmp/codex-home");

    await expect(mark(" thread-1 ", ` ${sourceHomeId} `, " /rollout.jsonl ")).resolves.toBe(true);
    await expect(mark("thread-1", sourceHomeId, "/new-path.jsonl")).resolves.toBe(true);
    await expect(store.has(sourceHomeId, "thread-1")).resolves.toBe(true);
    await expect(store.has("other-home", "thread-1")).resolves.toBe(false);
    await expect(store.has(sourceHomeId, "missing-thread")).resolves.toBe(false);
    expect(values.size).toBe(1);
    expect([...values.values()][0]).toMatchObject({
      kind: "managed-thread",
      sourceHomeId,
      threadId: "thread-1",
      rolloutPath: "/rollout.jsonl",
    });
    await expect(store.snapshot()).resolves.toEqual(
      new Map([[sourceHomeId, new Set(["thread-1"])]]),
    );
  });

  it("hydrates once and keeps concurrent marks within the global oldest-first bound", async () => {
    const { state, store, mark } = createStateStore();
    const pending = createDeferred<Awaited<ReturnType<typeof state.entries>>>();
    const entries = vi.spyOn(state, "entries").mockReturnValue(pending.promise);
    const snapshots = [store.snapshot(), store.snapshot()];
    await mark("thread-1");
    await expect(mark("new-thread")).resolves.toBe(true);
    pending.resolve(
      Array.from(
        { length: CODEX_MANAGED_THREAD_MAX_ENTRIES },
        (_, index): PluginStateEntry<StoredCodexManagedThread> => ({
          key: `persisted-${index}`,
          value: {
            version: 1,
            kind: "managed-thread",
            sourceHomeId: index === 0 ? "oldest-home" : "home",
            threadId: `thread-${index}`,
          },
          createdAt: index,
        }),
      ).toReversed(),
    );
    for (const snapshot of await Promise.all(snapshots)) {
      expect(snapshot.has("oldest-home")).toBe(false);
      expect(snapshot.get("home")?.size).toBe(CODEX_MANAGED_THREAD_MAX_ENTRIES);
      expect(snapshot.get("home")?.has("thread-1")).toBe(true);
      expect(snapshot.get("home")?.has("new-thread")).toBe(true);
    }
    await mark("after-hydration");
    await expect(store.has("home", "thread-1")).resolves.toBe(false);
    await mark("thread-2");
    await mark("latest-thread");
    await expect(store.has("home", "thread-2")).resolves.toBe(false);
    expect((await store.snapshot()).get("home")?.size).toBe(CODEX_MANAGED_THREAD_MAX_ENTRIES);
    await expect(store.has("home", "new-thread")).resolves.toBe(true);
    expect(entries).toHaveBeenCalledTimes(1);
  });

  it("waits for durable registration before reporting success", async () => {
    const { state, mark } = createStateStore();
    const durable = createDeferred<boolean>();
    state.registerIfAbsent = () => durable.promise;
    const finished = vi.fn();
    const marked = mark().then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    durable.resolve(false);
    await marked;
    expect(finished).toHaveBeenCalledWith(true);
  });

  it("warns and fails open after rejected storage or invalid input", async () => {
    const { state, store, mark } = createStateStore();
    const failure = new Error("synthetic storage rejection");
    state.registerIfAbsent = vi.fn<typeof state.registerIfAbsent>().mockRejectedValue(failure);
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    await expect(mark()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith("failed to record Codex managed thread ownership", {
      error: failure,
    });
    await expect(mark("thread", " ")).resolves.toBe(false);
    expect(state.registerIfAbsent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    await expect(store.snapshot()).resolves.toEqual(new Map());
  });

  it("propagates membership storage rejection and retries hydration", async () => {
    const { state, store } = createStateStore();
    const failure = new Error("synthetic read rejection");
    state.entries = vi.fn<typeof state.entries>().mockRejectedValue(failure);
    await expect(store.has("home", "thread")).rejects.toBe(failure);
    state.entries = async () => [];
    await expect(store.snapshot()).resolves.toEqual(new Map());
  });
});
