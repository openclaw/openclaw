import { stripVTControlCharacters } from "node:util";
import { createPluginStateKeyedStoreV2ForTests as openStore } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
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
    setLoggerOverride(null);
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
  vi.spyOn(runtimeModule, "getOptionalSignalRuntime").mockReturnValue(runtime);
  return runtime;
}

function watchConsoleWarnings() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Styling adds color codes when the runner forces color, so compare visible text only.
  return { lines: () => stripVTControlCharacters(warn.mock.calls.flat().map(String).join("\n")) };
}

it.each(["lookup", "register"] as const)(
  "prints %s failures on the console and keeps memory",
  async (stage) => {
    const runtime = installRuntime();
    const store = runtime.state.openKeyedStoreV2({ namespace: "failures", maxEntries: 10 });
    vi.spyOn(runtime.state, "openKeyedStoreV2").mockReturnValue(store);
    vi.spyOn(store, "lookup").mockResolvedValue(record);
    vi.spyOn(store, stage).mockRejectedValue(new Error("storage unavailable"));
    const consoleWarn = watchConsoleWarnings();
    await register();
    await expect(resolveContext(reply)).resolves.toEqual({
      author: input.author,
      body: stage === "lookup" ? "new" : "stored",
    });
    expect(consoleWarn.lines()).toMatch(
      /\[signal\] persistent reply author state failed error=.*storage unavailable/su,
    );
  },
);

it("prints an unavailable reply author store on the console", async () => {
  const runtime = installRuntime();
  vi.spyOn(runtime.state, "openKeyedStoreV2").mockImplementation(() => {
    throw new Error("state database is locked");
  });
  const consoleWarn = watchConsoleWarnings();
  await register({ body: "memory fallback" });
  await expect(resolveContext(reply)).resolves.toEqual({
    author: input.author,
    body: "memory fallback",
  });
  expect(consoleWarn.lines()).toMatch(
    /\[signal\] persistent reply author state unavailable error=.*locked/su,
  );
});

it("persists and reloads merged reply context with zero parent-thread SQL", async () => {
  const runtime = installRuntime();
  const { calls: counters } = observeHostDataSql();
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
