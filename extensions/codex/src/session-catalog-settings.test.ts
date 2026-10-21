import { expect, it, onTestFinished, vi } from "vitest";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import {
  catalogClient,
  catalogIndex,
  catalogThread,
} from "./session-catalog-client.test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
  subscribeCodexCatalogEvents,
} from "./session-catalog-events.js";
import { catalogWebSocketOptions } from "./session-catalog-index.test-support.js";
import { projectNativeCatalogFixture as projectCodexCatalogPage } from "./session-catalog-projection.test-support.js";

let fixtureId = 0;
const persisted = { cwd: "/workspace/persisted", modelProvider: "openai" };
const runtime = { cwd: "/workspace/runtime", modelProvider: "runtime-provider" };
const live = { cwd: "/workspace/live", modelProvider: "live-provider" };
const liveSettingsEvent = {
  method: "thread/settings/updated",
  params: { threadId: "thread-1", threadSettings: live },
};

function nativeThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    ...threadStartResult().thread,
    ...catalogThread(persisted),
    status: { type: "idle" },
    source: "cli",
    ...overrides,
  };
}

async function fixture(overflow = false, evicted = false) {
  const options = catalogWebSocketOptions(
    `wss://catalog-settings-${++fixtureId}.example.test/codex`,
  );
  const inventory = [
    nativeThread({ recencyAt: evicted ? 0 : 100 }),
    nativeThread({ id: "other", recencyAt: 200 }),
  ];
  if (overflow) {
    for (let i = inventory.length; i < 20_001; i++) {
      inventory.push(nativeThread({ id: `stored-${i}`, recencyAt: 1 }));
    }
  }
  const methods: string[] = [];
  const respond = (method: string, params: CodexThreadListParams) => {
    if (method === "thread/read") {
      return { thread: inventory.find((row) => row.id === params.threadId) };
    }
    if (method === "thread/resume") {
      return {
        ...threadStartResult(),
        thread: inventory[0]!,
        ...runtime,
      };
    }
    if (method !== "thread/list") {
      return undefined;
    }
    const ordered = overflow
      ? inventory.toSorted((left, right) => (right.recencyAt ?? 0) - (left.recencyAt ?? 0))
      : inventory;
    const matching = ordered.filter((thread) => !params.cwd || thread.cwd === params.cwd);
    const offset = Number(params.cursor ?? 0);
    const data = matching.slice(offset, offset + (params.limit ?? 0));
    return {
      data,
      nextCursor: offset + data.length < matching.length ? String(offset + data.length) : undefined,
    };
  };
  const create = () =>
    catalogClient(({ method, params }) => {
      methods.push(method);
      return respond(method, params);
    });
  const a = create();
  const b = create();
  // Worker startup is fixture setup, outside the live-settings request deadline.
  const reader = overflow ? b.client : a.client;
  await reader.request("thread/list", { limit: 1 }, { catalogPreview: true });
  methods.length = 0;
  await observeCodexCatalogClient(a.client, { startOptions: options });
  await observeCodexCatalogClient(b.client, { startOptions: options });
  const homeId = await codexCatalogResidentHomeKey({ startOptions: options });
  const index = catalogIndex({
    homeId,
    readNative: async (params: CodexThreadListParams) =>
      projectCodexCatalogPage(
        // Overflow queries still have a native reader after the live settings source closes.
        await reader.request("thread/list", params, { catalogPreview: true }),
      ),
  });
  await index.initialize();
  const abandonClient = vi.fn(async () => {});
  const resume = () =>
    resumeCodexAppServerThread({
      client: a.client,
      abandonClient,
      request: { threadId: "thread-1", excludeTurns: true },
      timeoutMs: 1_000,
    });
  const sessions = async (cwd?: string) => (await index.list({ cwd })).sessions;
  const session = async (cwd?: string) =>
    (await sessions(cwd)).find((row) => row.threadId === "thread-1");
  return { a, b, index, inventory, methods, homeId, resume, abandonClient, sessions, session };
}

it.each([false, true])(
  "keeps acknowledged resume settings authoritative (overflow=%s)",
  async (overflow) => {
    const { a, index, inventory, methods, resume, abandonClient, sessions } = await fixture(
      overflow,
      overflow,
    );
    if (overflow) {
      expect(index.get("thread-1")).toBeUndefined();
    }
    const findThread = async (cwd: string) => {
      let cursor: string | undefined;
      do {
        const page = await index.list({ cwd, cursor });
        const thread = page.sessions.find((session) => session.threadId === "thread-1");
        if (thread) {
          return thread;
        }
        cursor = page.nextCursor;
      } while (cursor);
      return undefined;
    };
    await resume();
    expect(await findThread(runtime.cwd)).toMatchObject({ threadId: "thread-1", ...runtime });
    expect(await findThread(persisted.cwd)).toBeUndefined();
    if (!overflow) {
      expect(await sessions(runtime.cwd)).toEqual([
        expect.objectContaining({ threadId: "thread-1", ...runtime }),
      ]);
      expect(index.get("thread-1")?.page.sessions[0]?.cwd).toBe(persisted.cwd);
      expect(methods).toEqual(["thread/list", "thread/resume"]);
      inventory[0]!.updatedAt = 300;
      const stale = await a.client.request("thread/read", {
        threadId: "thread-1",
        includeTurns: false,
      });
      await index.upsertThread(stale.thread);
      expect((await sessions(runtime.cwd))[0]).toMatchObject(runtime);
    }
    a.client.close();
    expect(await sessions(runtime.cwd)).toEqual([]);
    expect(await findThread(persisted.cwd)).toMatchObject({
      threadId: "thread-1",
      modelProvider: "openai",
    });
    expect(abandonClient).not.toHaveBeenCalled();
  },
);

it("keeps another connection's active status on overflow pages until it closes", async () => {
  const { a, inventory, session } = await fixture(true);
  inventory[0]!.status = { type: "notLoaded" };
  a.send({
    method: "thread/status/changed",
    params: {
      threadId: "thread-1",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    },
  });
  const expected = { status: "active", activeFlags: ["waitingOnApproval"] };
  expect(await session()).toMatchObject(expected);
  expect(await session("/workspace/persisted")).toMatchObject(expected);
  a.client.close();
  const closed = await session("/workspace/persisted");
  expect([closed?.status, closed?.activeFlags]).toEqual(["notLoaded", undefined]);
});

it("keeps a successful resume subscribed when a catalog observer fails", async () => {
  const { a, homeId, resume, abandonClient } = await fixture();
  const observer = vi.fn(async () => {
    throw new Error("catalog observer failed");
  });
  onTestFinished(subscribeCodexCatalogEvents(homeId, () => {}, { onResume: observer }));
  await expect(resume()).resolves.toMatchObject({ thread: { id: "thread-1" }, cwd: runtime.cwd });
  expect(observer).toHaveBeenCalledOnce();
  expect(abandonClient).not.toHaveBeenCalled();
  expect(a.client.getCloseError()).toBeUndefined();
});

it.each(["thread/status/changed", "thread/archived", "thread/deleted"])(
  "withdraws live settings on %s without leaking them into native metadata",
  async (method) => {
    const { a, b, index, inventory, methods, sessions, session } = await fixture();
    const unloaded = method === "thread/status/changed";
    const event = {
      method,
      params: { threadId: "thread-1", ...(unloaded ? { status: { type: "notLoaded" } } : {}) },
    };
    a.send(liveSettingsEvent);
    expect(await sessions(live.cwd)).toEqual([expect.objectContaining({ threadId: "thread-1" })]);
    if (unloaded) {
      b.send(event);
      expect((await sessions(live.cwd))[0]?.threadId).toBe("thread-1");
    }
    a.send(event);
    expect(await sessions(live.cwd)).toEqual([]);
    if (!unloaded) {
      await index.upsertThread(inventory[0]!);
      expect(await sessions(live.cwd)).toEqual([]);
    }
    expect(await session()).toMatchObject(persisted);
    if (unloaded) {
      expect(a.client.getCloseError()).toBeUndefined();
      expect(methods).toEqual(["thread/list"]);
    }
  },
);
