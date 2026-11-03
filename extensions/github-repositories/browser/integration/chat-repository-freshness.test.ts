import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../session-pull-requests-api.ts";
import { createGatewayHarness, flushSync } from "./session-pull-requests.test-support.ts";
const key = "agent:main:repository-freshness";
let harness: ReturnType<typeof createGatewayHarness>;
let store: ReturnType<typeof createGatewayHarness>["repository"]["store"];
const owner = {};
beforeEach(() => {
  harness = createGatewayHarness();
  store = harness.repository.store;
  vi.useFakeTimers();
});
afterEach(() => {
  store.unwatch(owner);
  vi.useRealTimers();
});
async function watch(keys: string[], options: Parameters<typeof store.watch>[2]) {
  store.watch(owner, keys, options);
  await flushSync();
}
async function unwatch() {
  store.unwatch(owner);
  await flushSync();
}
function expectSubscription(
  source: typeof harness,
  sessionKeys: string[],
  refreshSessionKeys: string[],
) {
  expect(source.request).toHaveBeenLastCalledWith(
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    { sessionKeys, refreshSessionKeys },
    { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
  );
}
it("refreshes once per streamed PR run through the plugin event and subscription owners", async () => {
  vi.useFakeTimers();
  await watch([key], { foreground: true });
  harness.request.mockClear();
  const delta = async (deltaText: string, runId = "run-1") => {
    harness.emit({ state: "delta", runId, sessionKey: key, deltaText }, "chat");
    await vi.advanceTimersByTimeAsync(5_000);
  };
  await delta("working on it ");
  expect(harness.request).not.toHaveBeenCalled();
  await delta("see https://github.com/openclaw/openclaw/issues/42 ");
  expect(harness.request).not.toHaveBeenCalled();
  await delta("opened https://github.com/openclaw/openclaw/pull/113840 for review ");
  expect(harness.request).toHaveBeenCalledTimes(1);
  expectSubscription(harness, [key], [key]);
  await delta("also https://github.com/openclaw/openclaw/pull/113900 ");
  expect(harness.request).toHaveBeenCalledTimes(1);
  await delta("continuing https://github.com/openclaw/openclaw/pu", "run-2");
  expect(harness.request).toHaveBeenCalledTimes(1);
  await delta("ll/113901 done", "run-2");
  expect(harness.request).toHaveBeenCalledTimes(2);
  await delta("merged https://github.com/openclaw/openclaw/pull/113840 at last", "run-3");
  expect(harness.request).toHaveBeenCalledTimes(3);
  await unwatch();
});

it.each([
  {
    name: "requests an authoritative refresh after a final assistant PR link",
    text: "Opened `https://github.com/openclaw/openclaw/pull/111532`.",
    refresh: true,
  },
  {
    name: "refreshes for a visible same-session final from another run",
    text: "Opened https://github.com/openclaw/openclaw/pull/111532",
    activeRunId: "active-run",
    runId: "announcement-run",
    refresh: true,
  },
  {
    name: "does not inspect the active stream for another run's final",
    text: "Finished the background task.",
    activeRunId: "active-run",
    runId: "announcement-run",
    stream: "Opened https://github.com/openclaw/openclaw/pull/111532",
    refresh: false,
  },
  {
    name: "does not refresh for an issue link",
    text: "Tracked in https://github.com/openclaw/openclaw/issues/111532.",
    refresh: false,
  },
  {
    name: "does not refresh for another session's PR announcement",
    text: "Opened https://github.com/openclaw/openclaw/pull/111532",
    sessionKey: "agent:main:other",
    refresh: false,
  },
])("$name", async ({ text, activeRunId, runId, stream, sessionKey, refresh }) => {
  await watch([key], { foreground: true });
  if (stream) {
    harness.emit(
      { state: "delta", runId: activeRunId, sessionKey: key, deltaText: stream },
      "chat",
    );
    await vi.advanceTimersByTimeAsync(5_000);
  }
  harness.request.mockClear();
  harness.emit(
    {
      state: "final",
      ...(runId ? { runId } : {}),
      sessionKey: sessionKey ?? key,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
    "chat",
  );
  await vi.advanceTimersByTimeAsync(5_000);
  if (refresh) {
    expect(harness.request).toHaveBeenCalledOnce();
    expectSubscription(harness, [key], [key]);
  } else {
    expect(harness.request).not.toHaveBeenCalled();
  }
});
