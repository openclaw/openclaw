import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import { codexCatalogSourceForClient } from "./session-catalog-source.js";

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
  const readNative = vi.fn(async (params: CodexThreadListParams) => {
    const offset = Number(params.cursor ?? 0);
    const limit = params.limit ?? 64;
    return projectCodexCatalogPage(
      {
        data: structuredClone(threads.slice(offset, offset + limit)),
        nextCursor: offset + limit < threads.length ? String(offset + limit) : null,
      },
      { sanitize: sanitizeTerminalText, source: codexCatalogSourceForClient(harness.client) },
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
  const complete = () =>
    harness.send({ method: "turn/completed", params: { threadId: "thread-1", turn: {} } });
  const reply = async (position: number, value: CodexThread) => {
    const request = JSON.parse(await harness.waitForWrite(position));
    expect(request).toMatchObject({
      method: "thread/read",
      params: { threadId: "thread-1", includeTurns: false },
    });
    harness.send({ id: request.id, result: { thread: value } });
    await nativeReads.mock.results[position]!.value;
  };
  return { index, harness, startOptions, nativeReads, readNative, complete, reply };
}

function notifyNameAndStatus(harness: ReturnType<typeof createClientHarness>): void {
  harness.send({
    method: "thread/name/updated",
    params: { threadId: "thread-1", threadName: "New title before publication" },
  });
  harness.send({
    method: "thread/status/changed",
    params: {
      threadId: "thread-1",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    },
  });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resident Codex catalog notifications", () => {
  it("leaves an unchanged home idle until the 15-minute native safety walk", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const inventory = Array.from({ length: 192 }, (_, i) =>
      thread({ id: `idle-${i}`, recencyAt: 1_000 - i }),
    );
    const { index, readNative } = await fixture(inventory);
    expect(readNative).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
    expect(readNative).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(readNative).toHaveBeenCalledTimes(3);
    inventory.pop();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
    expect(readNative).toHaveBeenCalledTimes(6);
    expect(index.get("idle-191")).toBeUndefined();
  });

  it("coalesces thread starts into a prefix walk and retains the unvisited tail", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const inventory = Array.from({ length: 192 }, (_, i) =>
      thread({ id: `stored-${i}`, recencyAt: 1_000 - i }),
    );
    const { index, harness, readNative } = await fixture(inventory);
    const newer = thread({ id: "newer", recencyAt: 2_000 });
    inventory.unshift(newer);
    harness.send({ method: "thread/started", params: { thread: newer } });
    await vi.waitFor(() => expect(index.get(newer.id)).toBeDefined());
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
    // The started row is already current, so its page establishes the known prefix.
    expect(readNative).toHaveBeenCalledTimes(4);
    expect((await index.list({})).sessions[0]?.threadId).toBe("newer");
    expect(index.get("stored-191")).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readNative).toHaveBeenCalledTimes(4);
  });

  it("reads changed pages through an unchanged page, then repairs silent tail changes at the bound", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const inventory = Array.from({ length: 256 }, (_, i) =>
      thread({ id: `stored-${i}`, recencyAt: 1_000 - i }),
    );
    const { index, harness, readNative } = await fixture(inventory);
    inventory[64]!.name = "Renamed without new activity";
    inventory[220]!.name = "Silent tail rename";
    inventory.pop();
    inventory.unshift(thread({ id: "missed-start", recencyAt: 1_999 }));
    const newer = thread({ id: "notified-start", recencyAt: 2_000 });
    inventory.unshift(newer);
    harness.send({ method: "thread/started", params: { thread: newer } });
    await vi.waitFor(() => expect(index.get(newer.id)).toBeDefined());
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
    expect(readNative).toHaveBeenCalledTimes(7);
    expect(index.get("missed-start")).toBeDefined();
    expect(index.get("stored-64")?.page.sessions[0]?.name).toBe("Renamed without new activity");
    expect(index.get("stored-220")?.page.sessions[0]?.name).toBeNull();
    expect(index.get("stored-255")).toBeDefined();
    await vi.advanceTimersByTimeAsync(14 * 60_000 + 30_000);
    await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
    expect(readNative).toHaveBeenCalledTimes(12);
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
      const { index, harness, nativeReads, readNative } = await fixture([first, second]);
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
      const firstRead = JSON.parse(await harness.waitForWrite(0));
      const secondRead = JSON.parse(await harness.waitForWrite(1));
      expect(firstRead).toMatchObject({ method: "thread/read", params: { threadId: first.id } });
      expect(secondRead).toMatchObject({ method: "thread/read", params: { threadId: second.id } });
      if (repeatFirst === "inflight") {
        harness.send({ method: "turn/completed", params: { threadId: first.id, turn: {} } });
        start(first.id);
      }
      harness.send({
        id: secondRead.id,
        result: { thread: { ...second, name: "Second read returned first" } },
      });
      await nativeReads.mock.results[1]!.value;
      await vi.waitFor(() =>
        expect(index.get(second.id)?.page.sessions[0]?.name).toBe("Second read returned first"),
      );
      harness.send({
        id: firstRead.id,
        result: { thread: { ...first, name: "First read returned last" } },
      });
      await nativeReads.mock.results[0]!.value;
      await vi.waitFor(() =>
        expect(index.get(first.id)?.page.sessions[0]?.name).toBe("First read returned last"),
      );
      if (repeatFirst === "inflight") {
        const latestRead = JSON.parse(await harness.waitForWrite(2));
        harness.send({
          id: latestRead.id,
          result: { thread: { ...first, name: "Latest first turn" } },
        });
        await nativeReads.mock.results[2]!.value;
        await vi.waitFor(() =>
          expect(index.get(first.id)?.page.sessions[0]?.name).toBe("Latest first turn"),
        );
      }
      expect((await index.list({})).sessions.map((row) => row.threadId)).toEqual(expected);
      expect(harness.writes).toHaveLength(repeatFirst === "inflight" ? 3 : 2);
      expect(readNative).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      change: "inserting a newer head",
      initial: ["alpha", "bravo"],
      refreshed: ["newer", "alpha", "bravo"],
      limit: 1,
    },
    {
      change: "removing a newer head",
      initial: ["newer", "alpha", "bravo"],
      refreshed: ["alpha", "bravo"],
      limit: 2,
    },
  ])(
    "keeps an existing tied-row cursor valid after $change",
    async ({ initial, refreshed, limit }) => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const nativeRows = (ids: string[]) =>
        ids.map((id) =>
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
        expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual(
          refreshed,
        );
      });
      expect(readNative).toHaveBeenCalledTimes(2);
      expect(readNative.mock.calls[1]?.[0]).toMatchObject({ useStateDbOnly: true });
      const next = await index.list({ limit, cursor: first.nextCursor });
      expect(next.sessions.map((session) => session.threadId)).toEqual(["bravo"]);
      expect(readNative).toHaveBeenCalledTimes(2);
    },
  );

  it("reconciles silent remote membership changes on its DB-only background interval", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const kept = thread({ id: "kept" });
    const inventory = [thread({ id: "removed" }), kept];
    const { index, readNative } = await fixture(inventory);
    expect(readNative).toHaveBeenCalledOnce();
    inventory.splice(0, inventory.length, thread({ id: "added" }), kept);
    expect((await index.list({})).sessions.map((session) => session.threadId).toSorted()).toEqual([
      "kept",
      "removed",
    ]);
    expect(readNative).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions.map((session) => session.threadId).toSorted()).toEqual(
        ["added", "kept"],
      );
    });
    expect(readNative).toHaveBeenCalledTimes(2);
    expect(readNative.mock.calls[1]?.[0]).toMatchObject({ useStateDbOnly: true });
    await index.list({});
    expect(readNative).toHaveBeenCalledTimes(2);
  });

  it("clears local live status on disconnect and accepts fresh status after reconnect", async () => {
    const { index, harness, startOptions, readNative } = await fixture(
      [thread({ status: { type: "active", activeFlags: ["waitingOnApproval"] } })],
      { local: true },
    );
    expect((await index.list({})).sessions[0]).toMatchObject({
      status: "active",
      activeFlags: ["waitingOnApproval"],
    });
    harness.client.close();
    const disconnected = (await index.list({})).sessions[0];
    expect(disconnected?.status).toBe("notLoaded");
    expect(disconnected).not.toHaveProperty("activeFlags");
    expect(readNative).toHaveBeenCalledOnce();
    const replacement = createClientHarness();
    cleanups.push(async () => replacement.client.close());
    await observeCodexCatalogClient(replacement.client, { startOptions });
    replacement.send({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: { type: "active", activeFlags: ["freshStatus"] },
      },
    });
    expect((await index.list({})).sessions[0]).toMatchObject({
      status: "active",
      activeFlags: ["freshStatus"],
    });
    expect(readNative).toHaveBeenCalledOnce();
  });

  it("does not revive active status from a native snapshot captured before local disconnect", async () => {
    const { index, harness, readNative } = await fixture([], {
      initialize: false,
      local: true,
    });
    const page = await projectCodexCatalogPage(
      {
        data: [
          thread({
            cwd: "/workspace/fresh",
            status: { type: "active", activeFlags: ["staleStatus"] },
          }),
        ],
      },
      { sanitize: sanitizeTerminalText, source: codexCatalogSourceForClient(harness.client) },
    );
    const response = createDeferred<typeof page>();
    const started = createDeferred<void>();
    readNative.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const initializing = index.initialize();
    try {
      await started.promise;
      harness.client.close();
      response.resolve(page);
      await initializing;
      const session = (await index.list({})).sessions[0];
      expect(session).toMatchObject({ cwd: "/workspace/fresh", status: "notLoaded" });
      expect(session).not.toHaveProperty("activeFlags");
      expect(readNative).toHaveBeenCalledOnce();
    } finally {
      response.resolve(page);
      await initializing;
    }
  });

  it("keeps newer status while publishing refreshed cwd and recency without another read", async () => {
    const { index, harness, complete, reply } = await fixture();
    complete();
    await harness.waitForWrite(0);
    harness.send({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    });
    await reply(0, thread({ cwd: "/workspace/fresh", recencyAt: 200, updatedAt: 200 }));
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions[0]).toMatchObject({
        cwd: "/workspace/fresh",
        recencyAt: 200,
        status: "active",
        activeFlags: ["waitingOnApproval"],
      });
    });
    expect(harness.writes).toHaveLength(1);
  });

  it("merges fresh hydration metadata with a newer name event without an exact read", async () => {
    const { index, harness, startOptions, readNative } = await fixture();
    harness.client.close();
    const refreshed = thread({ cwd: "/workspace/fresh", recencyAt: 200, updatedAt: 200 });
    const page = await projectCodexCatalogPage(
      { data: [{ ...refreshed }] },
      { sanitize: sanitizeTerminalText },
    );
    const response = createDeferred<typeof page>();
    readNative.mockImplementation(() => response.promise);
    const replacement = createClientHarness();
    cleanups.push(async () => replacement.client.close());
    try {
      await observeCodexCatalogClient(replacement.client, { startOptions });
      await vi.waitFor(() => expect(readNative).toHaveBeenCalledTimes(2));
      replacement.send({
        method: "thread/name/updated",
        params: { threadId: "thread-1", threadName: "Renamed during hydration" },
      });
      response.resolve(page);
      await nextTurn();
      expect(replacement.writes).toEqual([]);
      await vi.waitFor(async () => {
        expect((await index.list({})).sessions[0]).toMatchObject({
          name: "Renamed during hydration",
          cwd: "/workspace/fresh",
          recencyAt: 200,
        });
      });
      expect(readNative).toHaveBeenCalledTimes(2);
      expect(replacement.writes).toEqual([]);
    } finally {
      response.resolve(page);
      replacement.client.close();
    }
  });

  it("refreshes remote inventory after reconnect while lists keep returning resident memory", async () => {
    const { index, harness, startOptions, readNative } = await fixture();
    await nextTurn();
    expect(readNative).toHaveBeenCalledOnce();
    harness.client.close();
    const page = await projectCodexCatalogPage(
      { data: [thread({ id: "created-while-offline", name: "New remote session" })] },
      { sanitize: sanitizeTerminalText },
    );
    const response = createDeferred<typeof page>();
    readNative.mockImplementation(() => response.promise);
    const replacement = createClientHarness();
    cleanups.push(async () => replacement.client.close());
    try {
      await observeCodexCatalogClient(replacement.client, { startOptions });
      await vi.waitFor(() => expect(readNative).toHaveBeenCalledTimes(2));
      expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual([
        "thread-1",
      ]);
      expect(readNative).toHaveBeenCalledTimes(2);
      response.resolve(page);
      await vi.waitFor(async () => {
        expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual([
          "created-while-offline",
        ]);
      });
      await observeCodexCatalogClient(replacement.client, { startOptions });
      await nextTurn();
      expect(readNative).toHaveBeenCalledTimes(2);
    } finally {
      response.resolve(page);
    }
  });

  it("retries once when a replacement becomes ready before the old hydration fails", async () => {
    const { index, harness, startOptions, readNative } = await fixture([], { initialize: false });
    const page = await projectCodexCatalogPage(
      { data: [thread({ name: "Recovered on replacement" })] },
      { sanitize: sanitizeTerminalText },
    );
    const response = createDeferred<typeof page>();
    const started = createDeferred<void>();
    readNative.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    readNative.mockResolvedValue(page);
    const failure = new Error("old connection closed during hydration");
    const initializing = index.initialize().catch((error: unknown) => error);
    const replacement = createClientHarness();
    cleanups.push(async () => replacement.client.close());
    try {
      await started.promise;
      harness.client.close();
      await observeCodexCatalogClient(replacement.client, { startOptions });
      response.reject(failure);
      expect(await initializing).toBe(failure);
      await vi.waitFor(() => expect(readNative).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => {
        expect((await index.list({})).sessions[0]?.name).toBe("Recovered on replacement");
      });
      await nextTurn();
      expect(readNative).toHaveBeenCalledTimes(2);
    } finally {
      response.resolve(page);
      await initializing;
    }
  });

  it("uses started payloads without a read and waits for first-user content before publishing empty threads", async () => {
    const { index, harness, readNative } = await fixture([]);
    const nativeObserver = vi.fn();
    harness.client.addNotificationHandler(nativeObserver);
    const preview = "User request ".repeat(100);
    harness.send({
      method: "thread/started",
      params: { thread: thread({ id: "empty", preview: "", recencyAt: null }) },
    });
    harness.send({
      method: "thread/started",
      params: { thread: thread({ preview }) },
    });
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

  it("preserves name and status arriving immediately after an asynchronous started upsert", async () => {
    const { index, harness } = await fixture([]);
    harness.send({ method: "thread/started", params: { thread: thread({ name: "Old title" }) } });
    notifyNameAndStatus(harness);
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions[0]).toMatchObject({
        name: "New title before publication",
        status: "active",
        activeFlags: ["waitingOnApproval"],
      });
    });
    expect(harness.writes).toEqual([]);
  });

  it("preserves name and status received before native hydration publishes its row", async () => {
    const { index, harness, readNative } = await fixture([], { initialize: false });
    const page = await projectCodexCatalogPage(
      { data: [thread({ name: "Old title" })] },
      { sanitize: sanitizeTerminalText },
    );
    const response = createDeferred<typeof page>();
    const started = createDeferred<void>();
    readNative.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const initializing = index.initialize();
    try {
      await started.promise;
      notifyNameAndStatus(harness);
      response.resolve(page);
      await initializing;
      expect((await index.list({})).sessions[0]).toMatchObject({
        name: "New title before publication",
        status: "active",
        activeFlags: ["waitingOnApproval"],
      });
      expect(readNative).toHaveBeenCalledOnce();
      expect(harness.writes).toEqual([]);
    } finally {
      response.resolve(page);
      await initializing;
    }
  });

  it("preserves name and status received while a saved row is being restored", async () => {
    const response = createDeferred<Awaited<ReturnType<CodexCatalogState["entries"]>>>();
    const started = createDeferred<void>();
    const state: CodexCatalogState = {
      entries: async () => {
        started.resolve();
        return response.promise;
      },
      register: async () => {},
      delete: async () => false,
    };
    const { index, harness, readNative } = await fixture([], { initialize: false, state });
    const page = await projectCodexCatalogPage(
      { data: [thread({ name: "Saved title" })] },
      { sanitize: sanitizeTerminalText },
    );
    const listing = index.list({});
    try {
      await started.promise;
      notifyNameAndStatus(harness);
      response.resolve([
        { key: "row", createdAt: 1, value: { version: 1, kind: "row", row: page.rows[0]! } },
        { key: "complete", createdAt: 1, value: { version: 1, kind: "complete" } },
      ]);
      expect((await listing).sessions[0]).toMatchObject({
        name: "New title before publication",
        status: "active",
        activeFlags: ["waitingOnApproval"],
      });
      expect(readNative).not.toHaveBeenCalled();
      expect(harness.writes).toEqual([]);
    } finally {
      response.resolve([]);
      await listing;
    }
  });

  it("applies names and status immediately with the catalog bounds and no metadata read", async () => {
    const { index, harness } = await fixture();
    harness.send({
      method: "thread/name/updated",
      params: { threadId: "thread-1", threadName: `  ${"Title ".repeat(200)}  ` },
    });
    harness.send({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: { type: "active", activeFlags: [" waitingOnApproval "] },
      },
    });
    const active = (await index.list({})).sessions[0];
    expect(active?.name).toHaveLength(500);
    expect(active).toMatchObject({ status: "active", activeFlags: ["waitingOnApproval"] });
    harness.send({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
    });
    harness.send({
      method: "thread/status/changed",
      params: { threadId: "unknown", status: { type: "active" } },
    });
    expect((await index.list({})).sessions[0]).toMatchObject({ status: "idle" });
    expect((await index.list({})).sessions[0]?.activeFlags).toBeUndefined();
    expect(harness.writes).toEqual([]);
  });

  it("coalesces completion events during a metadata read into one follow-up read", async () => {
    const { index, harness, readNative, complete, reply } = await fixture();
    complete();
    await harness.waitForWrite(0);
    complete();
    complete();
    await reply(0, thread({ name: "Earlier completion", updatedAt: 101 }));
    await reply(1, thread({ name: "Latest completion", updatedAt: 102 }));
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions[0]?.name).toBe("Latest completion");
    });
    expect(harness.writes).toHaveLength(2);
    expect(readNative).toHaveBeenCalledOnce();
  });

  it.each(["archived", "deleted"])(
    "keeps a thread %s when an older metadata read settles and cancels queued rereads",
    async (action) => {
      const { index, harness, complete, reply } = await fixture();
      complete();
      await harness.waitForWrite(0);
      complete();
      harness.send({ method: `thread/${action}`, params: { threadId: "thread-1" } });
      expect((await index.list({})).sessions).toEqual([]);
      await reply(0, thread({ name: "Stale pre-archive data", updatedAt: 101 }));
      // The memory-only projection settles before the next event-loop turn.
      await nextTurn();
      expect((await index.list({})).sessions).toEqual([]);
      if (action === "archived") {
        expect(index.get("thread-1")?.archived).toBe(true);
      } else {
        expect(index.get("thread-1")).toBeUndefined();
      }
      expect(harness.writes).toHaveLength(1);
    },
  );

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
});
