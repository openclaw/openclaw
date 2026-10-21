import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { completeCatalogState } from "./session-catalog-index.test-support.js";
import { projectNativeCatalogFixture as projectCodexCatalogPage } from "./session-catalog-projection.test-support.js";
import { codexCatalogSourceForClient, setCodexCatalogSource } from "./session-catalog-source.js";

const cleanups: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let fixtureId = 0;

function thread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: "thread-1",
    projectId: null,
    preview: "The original user request",
    name: null,
    source: "cli",
    originator: "codex_cli_rs",
    cwd: "/workspace/project",
    updatedAt: 100,
    recencyAt: 100,
    status: { type: "idle" },
    ...overrides,
  };
}

async function fixture(
  threads = [thread()],
  options: { initialize?: boolean; state?: CodexCatalogState; local?: boolean } = {},
) {
  const home = options.local ? tempDirs.make("codex-catalog-local-status-") : undefined;
  const startOptions: CodexAppServerStartOptions = {
    transport: home ? "stdio" : "websocket",
    command: "codex",
    args: ["app-server"],
    ...(home
      ? { env: { CODEX_HOME: home } }
      : {
          url: `wss://catalog-events-${++fixtureId}.example.test/codex`,
          authToken: "synthetic-catalog-token",
        }),
    headers: {},
  };
  const homeId = await codexCatalogResidentHomeKey({ startOptions });
  const harness = createClientHarness();
  const nativeReads = vi.spyOn(harness.client, "request");
  const project = (data: CodexThread[], nextCursor: string | null = null) =>
    projectCodexCatalogPage({
      data: data.map((entry) =>
        setCodexCatalogSource(entry, codexCatalogSourceForClient(harness.client)),
      ),
      nextCursor,
    });
  const readNative = vi.fn(async (params: CodexThreadListParams) => {
    const offset = Number(params.cursor ?? 0);
    const limit = params.limit ?? 64;
    return project(
      structuredClone(threads.slice(offset, offset + limit)),
      offset + limit < threads.length ? String(offset + limit) : null,
    );
  });
  const index = new CodexCatalogIndex({
    homeId,
    readNative,
    state: options.state,
    ...(home ? { localSessionsRoot: path.join(home, "sessions") } : {}),
    assertCurrent: () => {},
  });
  cleanups.push(async () => {
    harness.client.close();
    await Promise.all([index.close(), harness.client.closeAndWait()]);
  });
  await observeCodexCatalogClient(harness.client, { startOptions });
  if (options.initialize !== false) {
    await index.initialize();
  }
  const notify = (method: string, params: Record<string, unknown>) =>
    harness.send({ method, params });
  const events = {
    complete: () => notify("turn/completed", { threadId: "thread-1", turn: {} }),
    started: (value = thread()) => notify("thread/started", { thread: value }),
    status: (value: CodexThread["status"], threadId = "thread-1") =>
      notify("thread/status/changed", { threadId, status: value }),
    name: (threadName: string) =>
      notify("thread/name/updated", { threadId: "thread-1", threadName }),
    request: async (position: number, threadId = "thread-1") => {
      const result = JSON.parse(await harness.waitForWrite(position));
      expect(result).toMatchObject({
        method: "thread/read",
        params: { threadId, includeTurns: false },
      });
      return result;
    },
    reply: async (position: number, value: CodexThread) => {
      const { id } = await events.request(position, value.id);
      harness.send({ id, result: { thread: value } });
      await nativeReads.mock.results[position]!.value;
    },
  };
  return { index, harness, startOptions, readNative, project, ...events };
}

const activeStatus = (flag = "waitingOnApproval") => ({
  type: "active" as const,
  activeFlags: [flag],
});
const activeSession = (flag = "waitingOnApproval") => ({ status: "active", activeFlags: [flag] });
const settled = (index: CodexCatalogIndex) =>
  vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
const sessions = async (index: CodexCatalogIndex) => (await index.list({})).sessions;
const ids = async (index: CodexCatalogIndex) => (await sessions(index)).map((row) => row.threadId);
const expectName = (index: CodexCatalogIndex, id: string, name: string) =>
  vi.waitFor(() => expect(index.get(id)?.page.sessions[0]?.name).toBe(name));
const warnings = () => vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
const expectWarning = (spy: ReturnType<typeof warnings>, error: unknown) =>
  expect(spy).toHaveBeenCalledExactlyOnceWith("Codex resident catalog background update failed", {
    error,
  });
function pendingRead<T>() {
  const response = createDeferred<T>();
  const started = createDeferred<void>();
  const read = () => {
    started.resolve();
    return response.promise;
  };
  return { response, started, read };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["activity", "safety"])(
  "settles a failed %s refresh until fresh activity or the next safety cycle",
  async (trigger) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { index, started: notify, readNative } = await fixture();
    const warning = warnings();
    readNative.mockRejectedValueOnce(new Error("native catalog unavailable"));
    if (trigger === "activity") {
      notify();
      await settled(index);
    }
    await vi.advanceTimersByTimeAsync(trigger === "activity" ? 30_000 : 15 * 60_000);
    if (trigger === "safety") {
      expect(readNative).toHaveBeenCalledOnce();
      await index.list({});
    }
    await settled(index);
    expect(readNative).toHaveBeenCalledTimes(2);
    expectWarning(
      warning,
      expect.objectContaining({
        cause: expect.objectContaining({ message: "native catalog unavailable" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(4 * 30_000);
    expect(readNative).toHaveBeenCalledTimes(2);
    notify();
    await settled(index);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled(index);
    expect(readNative).toHaveBeenCalledTimes(3);
    expect(warning).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "preserves an observation read failure with newer activity: %s",
  async (queuedActivity) => {
    const { index, harness, complete, reply, request } = await fixture();
    const warning = warnings();
    complete();
    const { id } = await request(0);
    if (queuedActivity) {
      complete();
    }
    harness.send({
      id,
      error: { code: -32603, message: "metadata read unavailable" },
    });
    await nextTurn();
    expect(harness.writes).toHaveLength(queuedActivity ? 2 : 1);
    if (queuedActivity) {
      await reply(1, thread({ name: "Fresh activity after failed read" }));
      await nextTurn();
      expect(index.get("thread-1")?.page.sessions[0]?.name).toBe(
        "Fresh activity after failed read",
      );
    }
    expect(index.hasActiveWork()).toBe(false);
    expectWarning(
      warning,
      expect.objectContaining({
        message: expect.stringContaining("metadata read unavailable"),
      }),
    );
    expect(harness.client.getCloseError()).toBeUndefined();
  },
);

it("preserves a catalog persistence failure", async () => {
  const error = new Error("catalog storage unavailable");
  const warning = warnings();
  await fixture([thread()], {
    state: {
      entries: async () => [],
      register: async () => {
        throw error;
      },
      delete: async () => false,
    },
  });
  expectWarning(warning, error);
});

it("reads changed pages through an unchanged page, then repairs silent tail changes at the bound", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const inventory = Array.from({ length: 256 }, (_, i) =>
    thread({ id: `stored-${i}`, recencyAt: 1_000 - i }),
  );
  const { index, started, readNative } = await fixture(inventory);
  inventory[16]!.name = "Renamed without new activity";
  inventory[220]!.name = "Silent tail rename";
  inventory.pop();
  inventory.unshift(thread({ id: "missed-start", recencyAt: 1_999 }));
  const newer = thread({ id: "notified-start", recencyAt: 2_000 });
  inventory.unshift(newer);
  started(newer);
  await vi.waitFor(() => expect(index.get(newer.id)).toBeDefined());
  await vi.advanceTimersByTimeAsync(30_000);
  await settled(index);
  expect(readNative).toHaveBeenCalledTimes(19);
  expect(index.get("missed-start")).toBeDefined();
  expect(index.get("stored-16")?.page.sessions[0]?.name).toBe("Renamed without new activity");
  expect(index.get("stored-220")?.page.sessions[0]?.name).toBeNull();
  expect(index.get("stored-255")).toBeDefined();
  await vi.advanceTimersByTimeAsync(14 * 60_000 + 30_000);
  expect(readNative).toHaveBeenCalledTimes(19);
  await index.list({ limit: 64 });
  await settled(index);
  expect(readNative).toHaveBeenCalledTimes(36);
  expect(index.get("stored-220")?.page.sessions[0]?.name).toBe("Silent tail rename");
  expect(index.get("stored-255")).toBeUndefined();
});

it.each([
  { repeatFirst: false, expected: ["second", "first"] },
  { repeatFirst: "queued", expected: ["first", "second"] },
  { repeatFirst: "inflight", expected: ["first", "second"] },
])(
  "preserves turn-start ordering across reversed reads (coalesced start: $repeatFirst)",
  async ({ repeatFirst, expected }) => {
    const first = thread({ id: "first" });
    const second = thread({ id: "second" });
    const { index, harness, reply, request, readNative } = await fixture([first, second]);
    let turn = 0;
    const start = (threadId: string) =>
      harness.send({
        method: "turn/started",
        params: { threadId, turn: { id: `turn-${++turn}`, startedAt: 100, items: [] } },
      });
    start(first.id);
    start(second.id);
    if (repeatFirst === "queued") {
      harness.send({ method: "turn/completed", params: { threadId: first.id, turn: {} } });
      start(first.id);
    }
    await request(0, first.id);
    await request(1, second.id);
    if (repeatFirst === "inflight") {
      harness.send({ method: "turn/completed", params: { threadId: first.id, turn: {} } });
      start(first.id);
    }
    await reply(1, { ...second, name: "Second read returned first" });
    await expectName(index, second.id, "Second read returned first");
    await reply(0, { ...first, name: "First read returned last" });
    await expectName(index, first.id, "First read returned last");
    if (repeatFirst === "inflight") {
      await reply(2, { ...first, name: "Latest first turn" });
      await expectName(index, first.id, "Latest first turn");
    }
    expect(await ids(index)).toEqual(expected);
    expect(harness.writes).toHaveLength(repeatFirst === "inflight" ? 3 : 2);
    expect(readNative).toHaveBeenCalledOnce();
  },
);

it.each([
  ["inserting", ["alpha", "bravo"], ["newer", "alpha", "bravo"], 1],
  ["removing", ["newer", "alpha", "bravo"], ["alpha", "bravo"], 2],
] as const)(
  "keeps tied-row cursors after %s a newer head",
  async (_change, initial, refreshed, limit) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const nativeRows = (threadIds: readonly string[]) =>
      threadIds.map((id) =>
        thread({
          id,
          recencyAt: id === "newer" ? 101 : 100,
          updatedAt: id === "newer" ? 101 : 100,
        }),
      );
    const inventory = nativeRows(initial);
    const { index, readNative } = await fixture(inventory);
    const first = await index.list({ limit });
    expect(first.sessions.at(-1)?.threadId).toBe("alpha");
    expect(first.nextCursor).toBeDefined();
    inventory.splice(0, inventory.length, ...nativeRows(refreshed));

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      expect(await ids(index)).toEqual(refreshed);
    });
    expect(readNative).toHaveBeenCalledTimes(2);
    expect(readNative.mock.calls[1]?.[0]).toMatchObject({ useStateDbOnly: true });
    const next = await index.list({ limit, cursor: first.nextCursor });
    expect(next.sessions.map((session) => session.threadId)).toEqual(["bravo"]);
    expect(readNative).toHaveBeenCalledTimes(2);
  },
);

it("clears local live status on disconnect and accepts fresh status after reconnect", async () => {
  const { index, harness, startOptions, readNative } = await fixture(
    [thread({ status: activeStatus() })],
    { local: true },
  );
  expect((await sessions(index))[0]).toMatchObject(activeSession());
  harness.client.close();
  const disconnected = (await sessions(index))[0];
  expect(disconnected?.status).toBe("notLoaded");
  expect(disconnected).not.toHaveProperty("activeFlags");
  expect(readNative).toHaveBeenCalledOnce();
  const replacement = createClientHarness();
  cleanups.push(async () => replacement.client.close());
  await observeCodexCatalogClient(replacement.client, { startOptions });
  replacement.send({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: activeStatus("freshStatus") },
  });
  expect((await sessions(index))[0]).toMatchObject(activeSession("freshStatus"));
  expect(readNative).toHaveBeenCalledOnce();
});

it("does not revive active status from a native snapshot captured before local disconnect", async () => {
  const { index, harness, readNative, project } = await fixture([], {
    initialize: false,
    local: true,
  });
  const page = await project([thread({ cwd: "/workspace/fresh", status: activeStatus("stale") })]);
  const { response, started, read } = pendingRead<typeof page>();
  readNative.mockImplementation(read);
  const initializing = index.initialize();
  try {
    await started.promise;
    harness.client.close();
    response.resolve(page);
    await initializing;
    const session = (await sessions(index))[0];
    expect(session).toMatchObject({ cwd: "/workspace/fresh", status: "notLoaded" });
    expect(session).not.toHaveProperty("activeFlags");
    expect(readNative).toHaveBeenCalledOnce();
  } finally {
    response.resolve(page);
    await initializing;
  }
});

it("uses started payloads without a read and waits for first-user content before publishing empty threads", async () => {
  const { index, harness, started, readNative } = await fixture([]);
  const nativeObserver = vi.fn();
  harness.client.addNotificationHandler(nativeObserver);
  const preview = "User request ".repeat(100);
  started(thread({ id: "empty", preview: "", recencyAt: null }));
  started(thread({ preview }));
  await vi.waitFor(async () => {
    const page = await index.list({});
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]).toMatchObject({ threadId: "thread-1" });
    expect(page.sessions[0]?.fallbackName).toHaveLength(500);
    expect(index.get("thread-1")?.preview).toHaveLength(500);
  });
  expect(harness.writes).toEqual([]);
  expect(readNative).toHaveBeenCalledOnce();
  expect(nativeObserver).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({ thread: expect.objectContaining({ preview }) }),
    }),
  );
});

it("preserves name and status received while a saved row is being restored", async () => {
  const { response, started, read } =
    pendingRead<Awaited<ReturnType<CodexCatalogState["entries"]>>>();
  const { index, harness, name, status, readNative } = await fixture([], {
    initialize: false,
    state: { entries: read, register: async () => {}, delete: async () => false },
  });
  const page = await projectCodexCatalogPage({ data: [thread({ name: "Saved title" })] });
  const listing = index.list({});
  try {
    await started.promise;
    name("New title before publication");
    status(activeStatus());
    response.resolve(await completeCatalogState([page.rows[0]!]).entries());
    expect((await listing).sessions[0]).toMatchObject({
      name: "New title before publication",
      ...activeSession(),
    });
    expect(readNative).not.toHaveBeenCalled();
    expect(harness.writes).toEqual([]);
  } finally {
    response.resolve([]);
    await listing;
  }
});

it("applies names and status immediately with the catalog bounds and no metadata read", async () => {
  const { index, harness, name, status } = await fixture();
  name(`  ${"Title ".repeat(200)}  `);
  status(activeStatus(" waitingOnApproval "));
  const active = (await sessions(index))[0];
  expect(active?.name).toHaveLength(500);
  expect(active).toMatchObject(activeSession());
  status({ type: "idle" });
  status({ type: "active" }, "unknown");
  const idle = (await sessions(index))[0];
  expect([idle?.status, idle?.activeFlags]).toEqual(["idle", undefined]);
  expect(harness.writes).toEqual([]);
});

it("does not start a queued reread after catalog shutdown", async () => {
  const { index, harness, complete, reply } = await fixture();
  complete();
  await harness.waitForWrite(0);
  complete();
  const closing = index.close();
  await reply(0, thread({ name: "Read settled during close" }));
  await closing;
  expect(harness.writes).toHaveLength(1);
});
