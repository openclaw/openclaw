import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import {
  CODEX_MANAGED_THREAD_MAX_ENTRIES,
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";

function createStateStore() {
  const values = new Map<string, StoredCodexManagedThread>();
  const state: Pick<
    PluginStateKeyedStore<StoredCodexManagedThread>,
    "entries" | "lookup" | "registerIfAbsent"
  > = {
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: async (key) => values.get(key),
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
  return { state, values };
}

describe("Codex managed thread store", () => {
  afterEach(() => vi.restoreAllMocks());
  it("records one durable ownership row per home and thread", async () => {
    const { state, values } = createStateStore();
    const store = createCodexManagedThreadStore(state);
    const sourceHomeId = codexCatalogHomeId("/tmp/codex-home");

    await expect(
      store.mark({
        sourceHomeId: ` ${sourceHomeId} `,
        threadId: " thread-1 ",
        rolloutPath: " /rollout.jsonl ",
      }),
    ).resolves.toBe(true);
    await expect(
      store.mark({ sourceHomeId, threadId: "thread-1", rolloutPath: "/new-path.jsonl" }),
    ).resolves.toBe(true);

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

  it("ignores malformed rows when building a snapshot", async () => {
    const { state, values } = createStateStore();
    values.set("malformed", {
      version: 1,
      kind: "managed-thread",
    } as unknown as StoredCodexManagedThread);

    await expect(createCodexManagedThreadStore(state).snapshot()).resolves.toEqual(new Map());
  });

  it("hydrates once and keeps concurrent marks within the global oldest-first bound", async () => {
    const { state } = createStateStore();
    const pending = createDeferred<Awaited<ReturnType<typeof state.entries>>>();
    const entries = vi.spyOn(state, "entries").mockReturnValue(pending.promise);
    const lookup = vi.spyOn(state, "lookup");
    const store = createCodexManagedThreadStore(state);
    const snapshots = [store.snapshot(), store.snapshot()];
    await store.mark({ sourceHomeId: "home", threadId: "thread-1" });
    await expect(store.mark({ sourceHomeId: "home", threadId: "new-thread" })).resolves.toBe(true);
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
    await store.mark({ sourceHomeId: "home", threadId: "after-hydration" });
    await expect(store.has("home", "thread-1")).resolves.toBe(false);
    await store.mark({ sourceHomeId: "home", threadId: "thread-2" });
    await store.mark({ sourceHomeId: "home", threadId: "latest-thread" });
    await expect(store.has("home", "thread-2")).resolves.toBe(false);
    for (let i = 0; i < 100; i++) {
      expect((await store.snapshot()).get("home")?.size).toBe(CODEX_MANAGED_THREAD_MAX_ENTRIES);
      await expect(store.has("home", "new-thread")).resolves.toBe(true);
    }
    expect(entries).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("waits for durable registration before reporting success", async () => {
    const { state } = createStateStore();
    const durable = createDeferred<boolean>();
    state.registerIfAbsent = () => durable.promise;
    const finished = vi.fn();
    const marked = createCodexManagedThreadStore(state)
      .mark({ sourceHomeId: "home", threadId: "thread" })
      .then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    durable.resolve(false);
    await marked;
    expect(finished).toHaveBeenCalledWith(true);
  });

  it("warns and fails open after rejected storage or invalid input", async () => {
    const { state } = createStateStore();
    const failure = new Error("synthetic storage rejection");
    state.registerIfAbsent = vi.fn(async () => {
      throw failure;
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    const store = createCodexManagedThreadStore(state);
    await expect(store.mark({ sourceHomeId: "home", threadId: "thread" })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith("failed to record Codex managed thread ownership", {
      error: failure,
    });
    await expect(store.mark({ sourceHomeId: " ", threadId: "thread" })).resolves.toBe(false);
    expect(state.registerIfAbsent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    await expect(store.snapshot()).resolves.toEqual(new Map());
  });

  it.each(["has", "snapshot"] as const)("propagates %s storage rejection", async (operation) => {
    const { state } = createStateStore();
    const failure = new Error("synthetic read rejection");
    state.lookup = async () => {
      throw failure;
    };
    state.entries = async () => {
      throw failure;
    };
    const store = createCodexManagedThreadStore(state);
    await expect(operation === "has" ? store.has("home", "thread") : store.snapshot()).rejects.toBe(
      failure,
    );
    state.entries = async () => [];
    await expect(store.snapshot()).resolves.toEqual(new Map());
  });

  it("uses the same source identity for a symlinked configured home", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-id-")));
    try {
      const home = path.join(root, "home");
      const alias = path.join(root, "alias");
      await fs.mkdir(home);
      await fs.symlink(home, alias, process.platform === "win32" ? "junction" : "dir");

      expect(codexCatalogHomeId(alias)).toBe(codexCatalogHomeId(home));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
