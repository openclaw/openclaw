import { setTimeout as delay } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import type { CodexCatalogState, StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";

function row(threadId: string, cwd = "/workspace"): CodexCatalogIndexRow {
  return {
    threadId,
    updatedAt: 100,
    recencyAt: 100,
    sourceOrder: 0,
    archived: false,
    nativeMetadata: true,
    page: {
      sessions: [
        { threadId, cwd, name: threadId, source: "cli", status: "notLoaded", archived: false },
      ],
    },
  };
}

function savedState(values: StoredCodexCatalogEntry[]): CodexCatalogState {
  return {
    entries: vi.fn(async () =>
      values.map((value, index) => ({ key: String(index), createdAt: 0, value })),
    ),
    register: vi.fn(async () => {}),
    delete: vi.fn(async () => false),
  };
}

describe("cold resident catalog availability", () => {
  it.each([
    {
      label: "an archived anchor during hydration",
      complete: false,
      removed: ["bravo"],
      previous: ["alpha"],
      following: ["charlie"],
    },
    {
      label: "a removed preceding page",
      complete: true,
      removed: ["alpha"],
      previous: ["bravo"],
      following: ["charlie"],
    },
    {
      label: "a removed preceding page during hydration",
      complete: false,
      removed: ["alpha"],
      previous: ["bravo"],
      following: ["charlie"],
    },
    {
      label: "a removed prefix and anchor",
      complete: true,
      removed: ["alpha", "bravo"],
      previous: ["charlie"],
      following: [],
    },
    {
      label: "an empty prefix during hydration",
      complete: false,
      removed: ["alpha", "bravo"],
      previous: [],
      following: ["charlie"],
    },
  ])(
    "keeps navigation after $label",
    async ({ complete, removed, previous: expectedPrevious, following: expectedFollowing }) => {
      const tailEntered = createDeferred<void>();
      const tail = createDeferred<void>();
      const readNative = vi.fn(async ({ cursor }: CodexThreadListParams) => {
        if (!cursor) {
          return {
            rows: [
              { ...row("alpha"), recencyAt: 300 },
              { ...row("bravo"), recencyAt: 200 },
            ],
            nextCursor: "native-tail",
          };
        }
        tailEntered.resolve();
        await tail.promise;
        return { rows: [row("charlie")] };
      });
      const index = new CodexCatalogIndex({
        homeId: "cold-backward-archive",
        readNative,
        assertCurrent: () => {},
      });
      try {
        const first = await index.list({ limit: 1 });
        await tailEntered.promise;
        if (complete) {
          tail.resolve();
          await index.initialize();
        }
        const second = await index.list({ limit: 1, cursor: first.nextCursor });
        expect(second.sessions.map((session) => session.threadId)).toEqual(["bravo"]);
        expect(second.backwardsCursor).toEqual(expect.any(String));
        for (const id of removed) {
          index.archive(id);
        }
        const previous = await index.list({ limit: 1, cursor: second.backwardsCursor });
        expect(previous.sessions.map((session) => session.threadId)).toEqual(expectedPrevious);
        expect(previous.backwardsCursor).toBeUndefined();
        if (expectedFollowing.length) {
          expect(previous.nextCursor).toEqual(expect.any(String));
        } else {
          expect(previous.nextCursor).toBeUndefined();
        }
        tail.resolve();
        await index.initialize();
        if (expectedFollowing.length) {
          const following = await index.list({ limit: 1, cursor: previous.nextCursor });
          expect(following.sessions.map((session) => session.threadId)).toEqual(expectedFollowing);
          expect(following.nextCursor).toBeUndefined();
        }
        expect(readNative).toHaveBeenCalledTimes(2);
      } finally {
        tail.resolve();
        await index.close();
      }
    },
  );

  it("shares one native first page among four cold callers without returning false empty results", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const readNative = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { rows: [row("head")] };
    });
    const index = new CodexCatalogIndex({
      homeId: "cold-four",
      readNative,
      assertCurrent: () => {},
    });
    let settled = 0;
    const calls = [{}, { limit: 1 }, { cwd: "/workspace" }, { searchTerm: "head" }].map((query) =>
      index.list(query).then((page) => {
        settled++;
        return page;
      }),
    );
    try {
      await entered.promise;
      expect(settled).toBe(0);
      expect(readNative).toHaveBeenCalledOnce();
      release.resolve();
      for (const page of await Promise.all(calls)) {
        expect(page.sessions.map((session) => session.threadId)).toEqual(["head"]);
        expect(page.nextCursor).toBeUndefined();
      }
      expect(readNative).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled(calls);
      await index.close();
    }
  });

  it("returns a progressing filtered frontier and bounds a caught-up continuation wait", async () => {
    const tailEntered = createDeferred<void>();
    const tail = createDeferred<void>();
    const readNative = vi.fn(async ({ cursor }: CodexThreadListParams) => {
      if (!cursor) {
        return { rows: [row("other", "/other")], nextCursor: "native-tail" };
      }
      tailEntered.resolve();
      await tail.promise;
      return { rows: [row("wanted")] };
    });
    const options = {
      homeId: "cold-filter",
      requestTimeoutMs: 30,
      readNative,
      assertCurrent: () => {},
    };
    const index = new CodexCatalogIndex(options);
    const firstCall = index.list({ cwd: "/workspace" });
    try {
      await tailEntered.promise;
      const first = await firstCall;
      expect(first.sessions).toEqual([]);
      expect(first.nextCursor).toEqual(expect.any(String));
      await expect(
        index.list({ cwd: "/workspace", cursor: first.nextCursor }),
      ).rejects.toMatchObject({ code: "APP_SERVER_UNAVAILABLE" });
      expect(readNative).toHaveBeenCalledTimes(2);
      tail.resolve();
      await index.initialize();
      const next = await index.list({ cwd: "/workspace", cursor: first.nextCursor });
      expect(next.sessions.map((session) => session.threadId)).toEqual(["wanted"]);
      expect(next.nextCursor).toBeUndefined();
    } finally {
      tail.resolve();
      await Promise.allSettled([firstCall]);
      await index.close();
    }
  });

  it("returns empty only after the initial native inventory confirms completion", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const index = new CodexCatalogIndex({
      homeId: "cold-empty",
      assertCurrent: () => {},
      readNative: async () => {
        entered.resolve();
        await release.promise;
        return { rows: [] };
      },
    });
    let settled = false;
    const pending = index.list({}).then((page) => {
      settled = true;
      return page;
    });
    try {
      await entered.promise;
      expect(settled).toBe(false);
      release.resolve();
      expect(await pending).toEqual({ sessions: [] });
    } finally {
      release.resolve();
      await pending;
      await index.close();
    }
  });

  it("serves a complete saved remote snapshot without waiting for native refresh", async () => {
    const readNative = vi.fn(async (_query: CodexThreadListParams) => ({ rows: [row("current")] }));
    const state = savedState([
      { version: 1, kind: "complete" },
      { version: 1, kind: "row", row: row("saved") },
    ]);
    const index = new CodexCatalogIndex({
      homeId: "saved-remote",
      state,
      readNative,
      assertCurrent: () => {},
    });
    try {
      expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual(["saved"]);
      expect(readNative).not.toHaveBeenCalled();
      await index.initialize();
      expect(readNative).toHaveBeenCalledOnce();
      expect(readNative.mock.calls[0]?.[0]).toMatchObject({ useStateDbOnly: true });
    } finally {
      await index.close();
    }
  });

  it.each(["missing", "invalid"] as const)(
    "does not expose a %s saved snapshot's stale tail",
    async (kind) => {
      const entries: StoredCodexCatalogEntry[] = [
        { version: 1, kind: "row", row: row("stale-tail") },
      ];
      if (kind === "invalid") {
        const invalid = row("invalid");
        invalid.page.sessions[0]!.name = "x".repeat(501);
        entries.push({ version: 1, kind: "complete" }, { version: 1, kind: "row", row: invalid });
      }
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const index = new CodexCatalogIndex({
        homeId: `saved-${kind}`,
        state: savedState(entries),
        assertCurrent: () => {},
        readNative: async () => {
          entered.resolve();
          await release.promise;
          return { rows: [row("current")] };
        },
      });
      let settled = false;
      const pending = index.list({}).then((page) => {
        settled = true;
        return page;
      });
      try {
        await entered.promise;
        expect(settled).toBe(false);
        release.resolve();
        expect((await pending).sessions.map((session) => session.threadId)).toEqual(["current"]);
      } finally {
        release.resolve();
        await pending;
        await index.close();
      }
    },
  );

  it("bounds a stalled restore without starting competing native work", async () => {
    const entries = createDeferred<Awaited<ReturnType<CodexCatalogState["entries"]>>>();
    const state = { ...savedState([]), entries: () => entries.promise };
    const readNative = vi.fn(async () => ({ rows: [] }));
    const options = {
      homeId: "restore-wait",
      state,
      readNative,
      requestTimeoutMs: 20,
      assertCurrent: () => {},
    };
    const index = new CodexCatalogIndex(options);
    const pending = index.list({}).then(
      (page) => ({ page }),
      (error: unknown) => ({ error }),
    );
    try {
      const result = await Promise.race([pending, delay(100).then(() => "still waiting")]);
      expect(result).toMatchObject({ error: { code: "APP_SERVER_UNAVAILABLE" } });
      expect(readNative).not.toHaveBeenCalled();
      entries.resolve([{ key: "complete", createdAt: 0, value: { version: 1, kind: "complete" } }]);
      expect(await index.list({})).toEqual({ sessions: [] });
      expect(readNative).not.toHaveBeenCalled();
    } finally {
      entries.resolve([]);
      await pending;
      await index.close();
    }
  });

  it("keeps event-owned tails outside an incomplete prefix and waits for old cursor boundaries", async () => {
    const at = (id: string, time: number) => ({ ...row(id), updatedAt: time, recencyAt: time });
    const native = [
      at("newest", 300),
      at("head", 200),
      at("middle", 150),
      at("old", 100),
      at("oldest", 50),
    ];
    const warm = new CodexCatalogIndex({
      homeId: "prefix",
      readNative: async () => ({ rows: native }),
      assertCurrent: () => {},
    });
    let oldForward: string | undefined;
    let oldBackward: string | undefined;
    try {
      await warm.initialize();
      const prefix = await warm.list({ limit: 3 });
      const old = await warm.list({ limit: 1, cursor: prefix.nextCursor });
      oldForward = old.nextCursor;
      oldBackward = old.backwardsCursor;
      expect(oldForward).toEqual(expect.any(String));
      expect(oldBackward).toEqual(expect.any(String));
    } finally {
      await warm.close();
    }
    const headEntered = createDeferred<void>();
    const headReady = createDeferred<void>();
    const tailReady = createDeferred<void>();
    const index = new CodexCatalogIndex({
      homeId: "prefix",
      assertCurrent: () => {},
      readNative: async ({ cursor }) => {
        if (!cursor) {
          headEntered.resolve();
          await headReady.promise;
          return { rows: native.slice(0, 2), nextCursor: "tail" };
        }
        await tailReady.promise;
        return { rows: native.slice(2) };
      },
    });
    const firstCall = index.list({ limit: 10 });
    const pending: Array<ReturnType<CodexCatalogIndex["list"]>> = [firstCall];
    try {
      await headEntered.promise;
      await index.upsertThread({
        id: "old",
        name: "old",
        source: "cli",
        projectId: null,
        updatedAt: 100,
        recencyAt: 100,
      });
      headReady.resolve();
      const first = await firstCall;
      expect.soft(first.sessions.map((session) => session.threadId)).toEqual(["newest", "head"]);
      const settled = { forward: false, backward: false };
      const forward = index.list({ limit: 1, cursor: oldForward }).then((page) => {
        settled.forward = true;
        return page;
      });
      const backward = index.list({ limit: 1, cursor: oldBackward }).then((page) => {
        settled.backward = true;
        return page;
      });
      pending.push(forward, backward);
      await delay(0);
      expect.soft(settled).toEqual({ forward: false, backward: false });
      tailReady.resolve();
      expect((await backward).sessions.map((session) => session.threadId)).toEqual(["middle"]);
      expect((await forward).sessions.map((session) => session.threadId)).toEqual(["oldest"]);
      const next = await index.list({ limit: 2, cursor: first.nextCursor });
      expect(next.sessions.map((session) => session.threadId)).toEqual(["middle", "old"]);
    } finally {
      headReady.resolve();
      tailReady.resolve();
      await Promise.allSettled(pending);
      await index.close();
    }
  });

  it("preserves a tied partial-page cursor across an initial hydration retry", async () => {
    const failTail = createDeferred<void>();
    let attempt = 0;
    const readNative = vi.fn(async ({ cursor }: CodexThreadListParams) => {
      if (!cursor) {
        attempt++;
        return { rows: [row("alpha"), row("bravo")], nextCursor: "tail" };
      }
      if (attempt === 1) {
        await failTail.promise;
        throw new Error("transient native failure");
      }
      return { rows: [row("charlie"), row("delta")] };
    });
    const index = new CodexCatalogIndex({
      homeId: "cold-retry",
      readNative,
      assertCurrent: () => {},
    });
    const initial = index.initialize();
    void initial.catch(() => undefined);
    try {
      const first = await index.list({ limit: 2 });
      expect(first.sessions.map((session) => session.threadId)).toEqual(["alpha", "bravo"]);
      expect(first.nextCursor).toEqual(expect.any(String));
      failTail.resolve();
      await expect(initial).rejects.toThrow("transient native failure");
      await index.initialize();
      const next = await index.list({ limit: 2, cursor: first.nextCursor });
      expect(next.sessions.map((session) => session.threadId)).toEqual(["charlie", "delta"]);
      expect(next.nextCursor).toBeUndefined();
    } finally {
      failTail.resolve();
      await Promise.allSettled([initial]);
      await index.close();
    }
  });
});
