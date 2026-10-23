import { DatabaseSync } from "node:sqlite";
import { createPluginStateKeyedStoreV2ForTests as openStore } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SignalReplyContextRecord as ReplyContext } from "./reply-authors-state.js";
import {
  registerSignalReplyContext as registerContext,
  resolveSignalReplyContextWithPersistence as resolveContext,
} from "./reply-authors.js";
import { resetSignalReplyAuthorsForTests } from "./reply-authors.test-helpers.js";
import * as runtimeModule from "./runtime.js";

const reply = { to: "signal:+15555550123", replyToId: "1700000000001" };
const input = { ...reply, author: "+15555550123", body: "new", sourceTimestamp: 200 };
const record: ReplyContext = {
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

beforeEach(resetSignalReplyAuthorsForTests);
const register = (overrides: Partial<Parameters<typeof registerContext>[0]> = {}) =>
  registerContext({ ...input, ...overrides });

async function expectReloaded(expected: Awaited<ReturnType<typeof resolveContext>>, key = reply) {
  resetSignalReplyAuthorsForTests();
  await expect(resolveContext(key)).resolves.toEqual(expected);
}

function installRuntime() {
  const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("signal-reply-worker-") };
  const runtime = createPluginRuntimeMock({
    state: {
      openKeyedStoreV2: <T>(options: Parameters<typeof openStore>[1]) =>
        openStore<T>("signal", { ...options, env }, { assertCurrent() {} }),
    },
  });
  const logger = runtime.logging.getChildLogger({});
  vi.spyOn(runtime.logging, "getChildLogger").mockReturnValue(logger);
  vi.spyOn(runtimeModule, "getOptionalSignalRuntime").mockReturnValue(runtime);
  return { runtime, logger };
}

it.each(["lookup", "register"] as const)("retains memory after %s fails", async (stage) => {
  const { runtime, logger } = installRuntime();
  const store = runtime.state.openKeyedStoreV2({ namespace: "failures", maxEntries: 10 });
  vi.spyOn(runtime.state, "openKeyedStoreV2").mockReturnValue(store);
  vi.spyOn(store, "lookup").mockResolvedValue(record);
  vi.spyOn(store, stage).mockRejectedValue(new Error("storage unavailable"));
  await register();
  expect(store[stage]).toHaveBeenCalledTimes(1);
  await expect(resolveContext(reply)).resolves.toEqual({
    author: input.author,
    body: stage === "lookup" ? "new" : "stored",
  });
  expect(logger.warn).toHaveBeenCalledWith("Signal persistent reply author state failed", {
    error: "Error: storage unavailable",
  });
});

it("persists and reloads merged reply context with zero parent-thread SQL", async () => {
  const { runtime } = installRuntime();
  const { calls: counters } = observeHostDataSql();
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
    counters.forEach((counter) => counter.mockClear());
  }
  const failOpen = () => {
    throw new Error("store temporarily unavailable");
  };
  vi.spyOn(runtime.state, "openKeyedStoreV2").mockImplementationOnce(failOpen);
  await register({ body: "memory fallback", sourceTimestamp: 50 });
  await Promise.all([
    register({ media: [{ kind: "unknown" }, { contentType: " image/png " }, {}] }),
    register({ body: "older", sourceTimestamp: 100 }),
  ]);
  await expectReloaded({
    author: input.author,
    body: "new",
    media: [{ kind: "unknown" }, { contentType: "image/png" }, {}],
  });
  await register({ author: "+15555550999" });
  await register({ sourceTimestamp: 400 });
  await expectReloaded({ ambiguous: true });
  const recoveredReply = { ...reply, replyToId: "1700000000002" };
  vi.mocked(runtime.state.openKeyedStoreV2).mockImplementationOnce(failOpen);
  await register(recoveredReply);
  await register({ ...recoveredReply, author: "+15555550999" });
  await expectReloaded({ ambiguous: true }, recoveredReply);
  expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
});
