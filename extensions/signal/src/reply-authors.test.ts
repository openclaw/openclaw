import { DatabaseSync } from "node:sqlite";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalReplyContextRecord } from "./reply-authors-state.js";
import {
  registerSignalReplyContext,
  resolveSignalReplyContextWithPersistence,
} from "./reply-authors.js";
import { resetSignalReplyAuthorsForTests } from "./reply-authors.test-helpers.js";
import * as runtimeModule from "./runtime.js";

const reply = { to: "signal:+15555550123", replyToId: "1700000000001" };
const input = { ...reply, author: "+15555550123", body: "new", sourceTimestamp: 200 };
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
  const unexpectedOperation = async () => {
    throw new Error("unexpected storage operation");
  };
  const store = {
    observe: vi.fn(unexpectedOperation),
    compareAndApply: vi.fn(unexpectedOperation),
    register: vi.fn(),
    registerIfAbsent: vi.fn(),
    lookup: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn(),
    delete: vi.fn(),
    entries: vi.fn(),
    clear: vi.fn(),
    lookupMany: vi.fn(unexpectedOperation),
    deleteIfEqual: vi.fn(unexpectedOperation),
    entriesInKeyRange: vi.fn(unexpectedOperation),
    moveEntriesFrom: vi.fn(unexpectedOperation),
    count: vi.fn(unexpectedOperation),
  } satisfies PluginStateKeyedStore<unknown, 2>;
  const runtime = createPluginRuntimeMock();
  const logger = runtime.logging.getChildLogger({});
  vi.spyOn(runtime.logging, "getChildLogger").mockReturnValue(logger);
  vi.spyOn(runtime.state, "openKeyedStoreV2").mockReturnValue(store);
  vi.spyOn(runtimeModule, "getOptionalSignalRuntime").mockReturnValue(runtime);
  return { store, runtime };
}

describe("Signal reply author storage failures", () => {
  it.each(["lookup", "register"] as const)(
    "keeps best-effort memory after %s rejects without retrying",
    async (failureStage) => {
      const { store, runtime } = installStore();
      store.lookup.mockResolvedValue(record);
      store[failureStage].mockRejectedValue(new Error("storage unavailable"));
      await registerSignalReplyContext(input);
      expect(store[failureStage]).toHaveBeenCalledTimes(1);
      await expect(resolveSignalReplyContextWithPersistence(reply)).resolves.toEqual({
        author: input.author,
        body: failureStage === "lookup" ? "new" : "stored",
      });
      expect(runtime.logging.getChildLogger({}).warn).toHaveBeenCalledWith(
        "Signal persistent reply author state failed",
        { error: "Error: storage unavailable" },
      );
    },
  );
});

it("persists and reloads merged reply context with zero parent-thread SQL", async () => {
  const tempDir = dirs.make("signal-reply-worker-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDir };
  const runtime = createPluginRuntimeMock({
    state: {
      openKeyedStoreV2: <T>(options: Parameters<typeof createPluginStateKeyedStoreV2ForTests>[1]) =>
        createPluginStateKeyedStoreV2ForTests<T>(
          "signal",
          { ...options, env },
          { assertCurrent() {} },
        ),
    },
  });
  vi.spyOn(runtimeModule, "getOptionalSignalRuntime").mockReturnValue(runtime);
  const observation = observeHostDataSql();
  const counters = observation.calls;
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
  vi.spyOn(runtime.state, "openKeyedStoreV2").mockImplementationOnce(() => {
    throw new Error("store temporarily unavailable");
  });
  await registerSignalReplyContext({ ...input, body: "memory fallback", sourceTimestamp: 50 });
  await Promise.all([
    registerSignalReplyContext(input),
    registerSignalReplyContext({ ...input, body: "older", sourceTimestamp: 100 }),
  ]);
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
  const recoveredReply = { ...reply, replyToId: "1700000000002" };
  vi.mocked(runtime.state.openKeyedStoreV2).mockImplementationOnce(() => {
    throw new Error("store temporarily unavailable");
  });
  await registerSignalReplyContext({ ...input, ...recoveredReply });
  await registerSignalReplyContext({ ...input, ...recoveredReply, author: "+15555550999" });
  resetSignalReplyAuthorsForTests();
  await expect(resolveSignalReplyContextWithPersistence(recoveredReply)).resolves.toEqual({
    ambiguous: true,
  });
  expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
});
