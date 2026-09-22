import { DatabaseSync, StatementSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  PluginStateCompareResult,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalReplyAuthorState, type SignalReplyContextRecord } from "./reply-authors-state.js";
import {
  registerSignalReplyContext,
  resolveSignalReplyContextWithPersistence,
} from "./reply-authors.js";
import { resetSignalReplyAuthorsForTests } from "./reply-authors.test-helpers.js";
import * as runtimeModule from "./runtime.js";

const reply = { to: "signal:+15555550123", replyToId: "1700000000001" };
const input = { ...reply, author: "+15555550123", body: "new", sourceTimestamp: 200 };
const key = "account=default|to=+15555550123|id=1700000000001";
const ttl = 7 * 24 * 60 * 60 * 1000;
const record: SignalReplyContextRecord = {
  kind: "resolved",
  accountId: "default",
  conversationKey: "+15555550123",
  replyToId: reply.replyToId,
  author: input.author,
  body: "stored",
  sourceTimestamp: 300,
  registeredAt: 1000,
};
const ambiguous: SignalReplyContextRecord = {
  kind: "ambiguous",
  accountId: "default",
  conversationKey: record.conversationKey,
  replyToId: record.replyToId,
  sourceTimestamp: record.sourceTimestamp,
  registeredAt: record.registeredAt,
};
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    resetSignalReplyAuthorsForTests();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

beforeEach(() => {
  resetSignalReplyAuthorsForTests();
});

function installStore() {
  const store = {
    observe: vi
      .fn<NonNullable<PluginStateKeyedStore<unknown>["observe"]>>()
      .mockResolvedValue({ value: undefined, comparison: "initial" }),
    compareAndApply: vi
      .fn<NonNullable<PluginStateKeyedStore<unknown>["compareAndApply"]>>()
      .mockResolvedValue({ status: "applied" }),
    update: vi.fn<NonNullable<PluginStateKeyedStore<unknown>["update"]>>(),
    register: vi.fn(),
    registerIfAbsent: vi.fn(),
    lookup: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn(),
    delete: vi.fn(),
    entries: vi.fn(),
    clear: vi.fn(),
  } satisfies PluginStateKeyedStore<unknown>;
  const runtime = createPluginRuntimeMock();
  const logger = runtime.logging.getChildLogger({});
  vi.spyOn(runtime.logging, "getChildLogger").mockReturnValue(logger);
  vi.spyOn(runtime.state, "openKeyedStore").mockReturnValue(store);
  vi.spyOn(runtimeModule, "getOptionalSignalRuntime").mockReturnValue(runtime);
  return { store, runtime };
}

describe("Signal reply author comparisons", () => {
  it.each([
    { name: "newer same author", current: record, expected: record },
    {
      name: "different author",
      current: { ...record, author: "+15555550999" },
      expected: { kind: "ambiguous", sourceTimestamp: 200 },
    },
    {
      name: "sticky ambiguity",
      current: ambiguous,
      expected: ambiguous,
    },
  ])("recomputes $name after a conflict with a fresh comparison", async ({ current, expected }) => {
    const { store } = installStore();
    vi.spyOn(Date, "now").mockReturnValue(2000);
    store.compareAndApply.mockImplementationOnce(async () => {
      vi.mocked(Date.now).mockReturnValue(4000);
      return { status: "conflict", current: { value: current, comparison: "fresh" } };
    });
    await registerSignalReplyContext(input);
    expect(store.compareAndApply).toHaveBeenCalledTimes(2);
    expect(store.compareAndApply).toHaveBeenLastCalledWith(key, "fresh", {
      operation: "update",
      action: "set",
      value: expect.objectContaining(expected),
    });
    const firstIntent = store.compareAndApply.mock.calls[0]?.[2];
    expect(firstIntent).toMatchObject({ value: { registeredAt: 2000 } });
    expect(signalReplyAuthorState.memoryReplyContexts.get(key)?.expiresAt).toBe(2000 + ttl);
    expect(store.observe).toHaveBeenCalledTimes(1);
    expect(store.update).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "success", author: input.author },
    { outcome: "failure", author: input.author },
    { outcome: "success", author: "+15555550999" },
    { outcome: "failure", author: "+15555550999" },
  ])(
    "reconciles reverse $outcome completion with later author $author",
    async ({ outcome, author }) => {
      const { store } = installStore();
      const firstCommit = createDeferred<void>();
      const firstResult = createDeferred<PluginStateCompareResult<unknown>>();
      vi.spyOn(Date, "now").mockReturnValue(1000);
      store.compareAndApply.mockImplementationOnce(async (_key, _comparison, intent) => {
        if (intent.action === "set") {
          store.observe.mockResolvedValue({ value: intent.value, comparison: "first-committed" });
        }
        firstCommit.resolve(undefined);
        return firstResult.promise;
      });
      const first = registerSignalReplyContext(input);
      await firstCommit.promise;
      vi.mocked(Date.now).mockReturnValue(2000);
      await registerSignalReplyContext({ ...input, author, body: "latest", sourceTimestamp: 400 });
      if (outcome === "success") {
        firstResult.resolve({ status: "applied" });
      } else {
        firstResult.reject(new Error("synthetic result unavailable after commit"));
      }
      await first;
      await expect(resolveSignalReplyContextWithPersistence(reply)).resolves.toEqual(
        author === input.author ? { author, body: "latest" } : { ambiguous: true },
      );
      expect(signalReplyAuthorState.memoryReplyContexts.get(key)).toMatchObject({
        registeredAt: 2000,
        sourceTimestamp: 400,
        expiresAt: 2000 + ttl,
      });
      expect(store.compareAndApply).toHaveBeenCalledTimes(2);
      expect(store.update).not.toHaveBeenCalled();
    },
  );

  it("publishes ambiguity from a retry even after another registration changed memory", async () => {
    const { store } = installStore();
    const firstAttempt = createDeferred<void>();
    const conflict = createDeferred<PluginStateCompareResult<unknown>>();
    store.compareAndApply.mockImplementationOnce(async () => {
      firstAttempt.resolve(undefined);
      return conflict.promise;
    });
    const first = registerSignalReplyContext(input);
    await firstAttempt.promise;
    await registerSignalReplyContext({ ...input, author: "+15555550999" });
    conflict.resolve({
      status: "conflict",
      current: { value: signalReplyAuthorState.memoryReplyContexts.get(key), comparison: "newer" },
    });
    await first;
    await expect(resolveSignalReplyContextWithPersistence(reply)).resolves.toEqual({
      ambiguous: true,
    });
    expect(store.compareAndApply).toHaveBeenCalledTimes(3);
  });

  it.each(["preexisting", "concurrent"] as const)(
    "does not revive %s expired cached ambiguity when persistence resolves the author",
    async (timing) => {
      const { store } = installStore();
      vi.spyOn(Date, "now").mockReturnValue(2000);
      const cacheExpired = () =>
        signalReplyAuthorState.memoryReplyContexts.set(key, {
          ...ambiguous,
          expiresAt: 1999,
        });
      if (timing === "preexisting") {
        cacheExpired();
      } else {
        store.compareAndApply.mockImplementationOnce(async () => {
          cacheExpired();
          return { status: "applied" };
        });
      }
      await registerSignalReplyContext(input);
      await expect(resolveSignalReplyContextWithPersistence(reply)).resolves.toEqual({
        author: input.author,
        body: "new",
      });
      expect(signalReplyAuthorState.memoryReplyContexts.get(key)?.expiresAt).toBe(2000 + ttl);
    },
  );

  it.each(["observe", "compareAndApply"] as const)(
    "keeps best-effort memory without retrying or using legacy writes after %s rejects",
    async (failureStage) => {
      const { store, runtime } = installStore();
      store[failureStage].mockRejectedValue(new Error("synthetic transport rejection"));
      store.lookup.mockResolvedValue(record);
      await registerSignalReplyContext(input);
      expect(store[failureStage]).toHaveBeenCalledTimes(1);
      expect(store.update).not.toHaveBeenCalled();
      expect(store.lookup).toHaveBeenCalledTimes(failureStage === "observe" ? 1 : 0);
      await expect(resolveSignalReplyContextWithPersistence(reply)).resolves.toEqual({
        author: input.author,
        body: failureStage === "observe" ? "stored" : "new",
      });
      expect(runtime.logging.getChildLogger({}).warn).toHaveBeenCalledWith(
        "Signal persistent reply author state failed",
        { error: "Error: synthetic transport rejection" },
      );
    },
  );

  it.each(["observe", "compareAndApply", "both"] as const)(
    "uses the published-host atomic callback when %s is absent",
    async (missing) => {
      const { store } = installStore();
      const compatible: PluginStateKeyedStore<unknown> = store;
      if (missing !== "compareAndApply") {
        delete compatible.observe;
      }
      if (missing !== "observe") {
        delete compatible.compareAndApply;
      }
      store.update.mockImplementation(async (_key, merge) => {
        expect(merge(record)).toEqual(record);
        return true;
      });
      await registerSignalReplyContext(input);
      expect(store.update).toHaveBeenCalledTimes(1);
      await expect(resolveSignalReplyContextWithPersistence(reply)).resolves.toEqual({
        author: input.author,
        body: "stored",
      });
    },
  );

  it("supports comparison-only hosts and disables persistence only when no atomic route exists", async () => {
    const { store } = installStore();
    const capabilities: PluginStateKeyedStore<unknown> = store;
    delete capabilities.update;
    await registerSignalReplyContext(input);
    expect(store.compareAndApply).toHaveBeenCalledTimes(1);
    expect(signalReplyAuthorState.persistentStoreDisabled).toBe(false);
    delete capabilities.observe;
    await registerSignalReplyContext({ ...input, author: "+15555550999" });
    expect(signalReplyAuthorState.persistentStoreDisabled).toBe(true);
    await expect(resolveSignalReplyContextWithPersistence(reply)).resolves.toEqual({
      ambiguous: true,
    });
  });
});

it("persists and reloads merged reply context with zero parent-thread SQL", async () => {
  const tempDir = dirs.make("signal-reply-worker-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDir };
  const runtime = createPluginRuntimeMock({
    state: {
      openKeyedStore: <T>(options: Parameters<typeof createPluginStateKeyedStoreForTests>[1]) =>
        createPluginStateKeyedStoreForTests<T>("signal", { ...options, env }),
    },
  });
  vi.spyOn(runtimeModule, "getOptionalSignalRuntime").mockReturnValue(runtime);
  const counters = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  const calibration = new DatabaseSync(":memory:");
  try {
    calibration.exec("CREATE TABLE counter (value INTEGER)");
    calibration.prepare("INSERT INTO counter VALUES (?)").run(1);
    calibration.prepare("SELECT value FROM counter").get();
    calibration.prepare("SELECT value FROM counter").all();
    expect([...calibration.prepare("SELECT value FROM counter").iterate()]).toEqual([{ value: 1 }]);
    expect(counters.every((counter) => counter.mock.calls.length > 0)).toBe(true);
  } finally {
    calibration.close();
    for (const counter of counters) {
      counter.mockClear();
    }
  }
  await registerSignalReplyContext(input);
  await registerSignalReplyContext({ ...input, body: "older", sourceTimestamp: 100 });
  resetSignalReplyAuthorsForTests();
  await expect(resolveSignalReplyContextWithPersistence(reply)).resolves.toEqual({
    author: input.author,
    body: "new",
  });
  await registerSignalReplyContext({ ...input, author: "+15555550999" });
  await registerSignalReplyContext({ ...input, sourceTimestamp: 400 });
  resetSignalReplyAuthorsForTests();
  await expect(resolveSignalReplyContextWithPersistence(reply)).resolves.toEqual({
    ambiguous: true,
  });
  expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
});
