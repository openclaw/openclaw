import { setTimeout as delay } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import { catalogThread } from "./session-catalog-client.test-support.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { catalogRow, completeCatalogState } from "./session-catalog-index.test-support.js";

const homeId = "cold-start";
const indexes: CodexCatalogIndex[] = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
const anyCursor = expect.any(String);
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0));
  await Promise.all(indexes.splice(0).map((index) => index.close()));
});

function gate() {
  const deferred = createDeferred<void>();
  releases.push(() => deferred.resolve());
  return deferred;
}

function row(threadId: string, cwd = "/workspace") {
  return catalogRow(threadId, 100, { cwd, name: threadId, source: "cli" }, { sourceOrder: 0 });
}

function createIndex(
  options: Omit<ConstructorParameters<typeof CodexCatalogIndex>[0], "assertCurrent" | "homeId">,
) {
  const index = new CodexCatalogIndex({ homeId, assertCurrent: () => {}, ...options });
  indexes.push(index);
  return index;
}

function gatedPages(head: ReturnType<typeof row>[], tailRows: ReturnType<typeof row>[]) {
  const tailEntered = gate();
  const tail = gate();
  const readNative = vi.fn(async ({ cursor }: CodexThreadListParams) => {
    if (!cursor) {
      return { rows: head, nextCursor: "native-tail" };
    }
    tailEntered.resolve();
    await tail.promise;
    return { rows: tailRows };
  });
  return { tailEntered, tail, readNative };
}

function expectPage(
  page: Awaited<ReturnType<CodexCatalogIndex["list"]>>,
  ids: readonly string[],
  cursors: { nextCursor?: unknown; backwardsCursor?: unknown } = {},
) {
  expect(page.sessions.map((session) => session.threadId)).toEqual(ids);
  expect({ nextCursor: page.nextCursor, backwardsCursor: page.backwardsCursor }).toMatchObject(
    cursors,
  );
}

it.each([
  ["a removed preceding page", true, ["alpha"], ["bravo"]],
  ["an empty prefix during hydration", false, ["alpha", "bravo"], []],
] as const)("keeps navigation after %s", async (_label, complete, removed, expectedPrevious) => {
  const { tailEntered, tail, readNative } = gatedPages(
    [
      { ...row("alpha"), recencyAt: 300 },
      { ...row("bravo"), recencyAt: 200 },
    ],
    [row("charlie")],
  );
  const index = createIndex({ readNative });
  const first = await index.list({ limit: 1 });
  await tailEntered.promise;
  if (complete) {
    tail.resolve();
    await index.initialize();
  }
  const second = await index.list({ limit: 1, cursor: first.nextCursor });
  expectPage(second, ["bravo"], { backwardsCursor: anyCursor });
  for (const id of removed) {
    index.archive(id);
  }
  const previous = await index.list({ limit: 1, cursor: second.backwardsCursor });
  expectPage(previous, expectedPrevious, { backwardsCursor: undefined, nextCursor: anyCursor });
  tail.resolve();
  await index.initialize();
  const following = await index.list({ limit: 1, cursor: previous.nextCursor });
  expectPage(following, ["charlie"], { nextCursor: undefined });
});

it("returns a progressing filtered frontier and bounds a caught-up continuation wait", async () => {
  const { tailEntered, tail, readNative } = gatedPages([row("other", "/other")], [row("wanted")]);
  const index = createIndex({ requestTimeoutMs: 30, readNative });
  const firstCall = index.list({ cwd: "/workspace" });
  pending.push(firstCall);
  await tailEntered.promise;
  const first = await firstCall;
  expectPage(first, [], { nextCursor: anyCursor });
  await expect(index.list({ cwd: "/workspace", cursor: first.nextCursor })).rejects.toMatchObject({
    code: "APP_SERVER_UNAVAILABLE",
  });
  tail.resolve();
  await index.initialize();
  const next = await index.list({ cwd: "/workspace", cursor: first.nextCursor });
  expectPage(next, ["wanted"], { nextCursor: undefined });
});

it("does not expose an invalid saved snapshot's stale tail", async () => {
  const invalid = row("invalid");
  invalid.page.sessions[0]!.name = "x".repeat(501);
  const entered = gate();
  const release = gate();
  const index = createIndex({
    state: completeCatalogState([row("stale-tail"), invalid]),
    readNative: async () => {
      entered.resolve();
      await release.promise;
      return { rows: [row("current")] };
    },
  });
  let settled = false;
  const listed = index.list({}).then((page) => {
    settled = true;
    return page;
  });
  pending.push(listed);
  await entered.promise;
  expect(settled).toBe(false);
  release.resolve();
  expectPage(await listed, ["current"]);
});

it("bounds a stalled restore without starting competing native work", async () => {
  const entries = createDeferred<Awaited<ReturnType<CodexCatalogState["entries"]>>>();
  releases.push(() => entries.resolve([]));
  const state = { ...completeCatalogState([]), entries: () => entries.promise };
  const readNative = vi.fn(async () => ({ rows: [] }));
  const index = createIndex({ state, readNative, requestTimeoutMs: 20 });
  const listed = index.list({});
  pending.push(listed);
  await expect(Promise.race([listed, delay(100)])).rejects.toMatchObject({
    code: "APP_SERVER_UNAVAILABLE",
  });
  expect(readNative).not.toHaveBeenCalled();
  entries.resolve([{ key: "complete", createdAt: 0, value: { version: 1, kind: "complete" } }]);
  expect(await index.list({})).toEqual({ sessions: [] });
  expect(readNative).not.toHaveBeenCalled();
});

it("keeps event-owned tails outside an incomplete prefix and waits for old cursor boundaries", async () => {
  const at = (id: string, time: number) => ({ ...row(id), updatedAt: time, recencyAt: time });
  const times = { newest: 300, head: 200, middle: 150, old: 100, oldest: 50 };
  const native = Object.entries(times).map(([id, time]) => at(id, time));
  const warm = createIndex({ readNative: async () => ({ rows: native }) });
  await warm.initialize();
  const prefix = await warm.list({ limit: 3 });
  const old = await warm.list({ limit: 1, cursor: prefix.nextCursor });
  expectPage(old, ["old"], { nextCursor: anyCursor, backwardsCursor: anyCursor });
  await warm.close();
  indexes.pop();
  const headEntered = gate();
  const headReady = gate();
  const tailReady = gate();
  const index = createIndex({
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
  pending.push(firstCall);
  await headEntered.promise;
  await index.upsertThread(catalogThread({ id: "old", name: "old" }));
  headReady.resolve();
  const first = await firstCall;
  expect.soft(first.sessions.map((session) => session.threadId)).toEqual(["newest", "head"]);
  const forward = index.list({ limit: 1, cursor: old.nextCursor });
  const backward = index.list({ limit: 1, cursor: old.backwardsCursor });
  pending.push(forward, backward);
  expect
    .soft(await Promise.race([forward, backward, delay(0).then(() => "pending")]))
    .toBe("pending");
  tailReady.resolve();
  expectPage(await backward, ["middle"]);
  expectPage(await forward, ["oldest"]);
  const next = await index.list({ limit: 2, cursor: first.nextCursor });
  expectPage(next, ["middle", "old"]);
});

it("preserves a tied partial-page cursor across an initial hydration retry", async () => {
  const failTail = gate();
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
  const index = createIndex({ readNative });
  const initial = index.initialize();
  void initial.catch(() => undefined);
  pending.push(initial);
  const first = await index.list({ limit: 2 });
  expectPage(first, ["alpha", "bravo"], { nextCursor: anyCursor });
  failTail.resolve();
  await expect(initial).rejects.toThrow("transient native failure");
  await index.initialize();
  const next = await index.list({ limit: 2, cursor: first.nextCursor });
  expectPage(next, ["charlie", "delta"], { nextCursor: undefined });
});
