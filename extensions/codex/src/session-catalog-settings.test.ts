import { afterEach, expect, it, vi } from "vitest";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
  subscribeCodexCatalogEvents,
} from "./session-catalog-events.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { catalogWebSocketOptions } from "./session-catalog-index.test-support.js";
import { projectNativeCatalogFixture as projectCodexCatalogPage } from "./session-catalog-projection.test-support.js";

const cleanups: Array<() => Promise<void>> = [];
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
    name: "Native thread",
    preview: "First user request",
    source: "cli",
    ...persisted,
    createdAt: 100,
    updatedAt: 100,
    recencyAt: 100,
    status: { type: "idle" },
    ...overrides,
  };
}

function resumeResponse(thread: ReturnType<typeof nativeThread>) {
  return {
    thread,
    model: "fixture-model",
    ...runtime,
    serviceTier: null,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: null,
    reasoningEffort: null,
  };
}

async function fixture(overflow = false, evicted = false) {
  const options = {
    ...catalogWebSocketOptions(`wss://catalog-settings-${++fixtureId}.example.test/codex`),
    authToken: "synthetic-settings-token",
  };
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
  const create = () =>
    createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line);
        methods.push(request.method);
        if (request.method === "thread/list") {
          const ordered = overflow
            ? inventory.toSorted((left, right) => (right.recencyAt ?? 0) - (left.recencyAt ?? 0))
            : inventory;
          const matching = ordered.filter(
            (thread) => !request.params.cwd || thread.cwd === request.params.cwd,
          );
          const offset = Number(request.params.cursor ?? 0);
          const data = matching.slice(offset, offset + request.params.limit);
          send({
            id: request.id,
            result: {
              data,
              nextCursor:
                offset + data.length < matching.length ? String(offset + data.length) : undefined,
            },
          });
        } else if (request.method === "thread/read") {
          send({
            id: request.id,
            result: { thread: inventory.find((row) => row.id === request.params.threadId) },
          });
        } else if (request.method === "thread/resume") {
          send({ id: request.id, result: resumeResponse(inventory[0]!) });
        }
      },
    });
  const a = create();
  const b = create();
  cleanups.push(async () => {
    await Promise.all([a.client.closeAndWait(), b.client.closeAndWait()]);
  });
  // Worker startup is fixture setup, outside the live-settings request deadline.
  const reader = overflow ? b.client : a.client;
  await reader.request("thread/list", { limit: 1 }, { catalogPreview: true });
  methods.length = 0;
  await observeCodexCatalogClient(a.client, { startOptions: options });
  await observeCodexCatalogClient(b.client, { startOptions: options });
  const homeId = await codexCatalogResidentHomeKey({ startOptions: options });
  const index = new CodexCatalogIndex({
    homeId,
    readNative: async (params: CodexThreadListParams) =>
      projectCodexCatalogPage(
        // Overflow queries still have a native reader after the live settings source closes.
        await reader.request("thread/list", params, { catalogPreview: true }),
      ),
    assertCurrent: () => {},
  });
  cleanups.push(() => index.close());
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

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

it("keeps live resume settings authoritative for overflow cwd queries after eviction", async () => {
  const { a, index, resume } = await fixture(true, true);
  expect(index.get("thread-1")).toBeUndefined();
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
  a.client.close();
  expect((await index.list({ cwd: "/workspace/runtime" })).sessions).toEqual([]);
  expect(await findThread(persisted.cwd)).toMatchObject({
    threadId: "thread-1",
    modelProvider: "openai",
  });
});

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
  expect(closed?.status).toBe("notLoaded");
  expect(closed?.activeFlags).toBeUndefined();
});

it("publishes acknowledged resume settings before returning and keeps stale native metadata behind the live overlay", async () => {
  const { a, index, inventory, methods, resume, abandonClient, sessions } = await fixture();
  await resume();
  expect(await sessions("/workspace/runtime")).toEqual([
    expect.objectContaining({ threadId: "thread-1", modelProvider: "runtime-provider" }),
  ]);
  expect(index.get("thread-1")?.page.sessions[0]?.cwd).toBe("/workspace/persisted");
  expect(methods).toEqual(["thread/list", "thread/resume"]);
  inventory[0]!.updatedAt = 300;
  const stale = await a.client.request("thread/read", {
    threadId: "thread-1",
    includeTurns: false,
  });
  await index.upsertThread(stale.thread);
  expect((await sessions(runtime.cwd))[0]).toMatchObject(runtime);
  a.client.close();
  expect(await sessions("/workspace/runtime")).toEqual([]);
  expect((await sessions(persisted.cwd)).some((row) => row.threadId === "thread-1")).toBe(true);
  expect(abandonClient).not.toHaveBeenCalled();
});

it("withdraws settings only when their supporting source reports notLoaded", async () => {
  const { a, b, methods, sessions, session } = await fixture();
  a.send(liveSettingsEvent);
  const unloaded = {
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "notLoaded" } },
  };
  b.send(unloaded);
  expect((await sessions("/workspace/live"))[0]?.threadId).toBe("thread-1");
  a.send(unloaded);
  expect(await sessions("/workspace/live")).toEqual([]);
  expect(await session()).toMatchObject(persisted);
  expect(a.client.getCloseError()).toBeUndefined();
  expect(methods).toEqual(["thread/list"]);
});

it("keeps a successful resume subscribed when a catalog observer fails", async () => {
  const { a, homeId, resume, abandonClient } = await fixture();
  const observer = vi.fn(async () => {
    throw new Error("catalog observer failed");
  });
  const stop = subscribeCodexCatalogEvents(homeId, () => {}, { onResume: observer });
  try {
    await expect(resume()).resolves.toMatchObject({
      thread: { id: "thread-1" },
      cwd: "/workspace/runtime",
    });
    expect(observer).toHaveBeenCalledOnce();
    expect(abandonClient).not.toHaveBeenCalled();
    expect(a.client.getCloseError()).toBeUndefined();
  } finally {
    stop();
  }
});

it.each(["thread/archived", "thread/deleted"])(
  "clears live settings on %s before a native row reappears",
  async (method) => {
    const { a, index, inventory, sessions, session } = await fixture();
    a.send(liveSettingsEvent);
    expect(await sessions("/workspace/live")).toHaveLength(1);
    a.send({ method, params: { threadId: "thread-1" } });
    expect(await sessions("/workspace/live")).toEqual([]);
    await index.upsertThread(inventory[0]!);
    expect(await sessions("/workspace/live")).toEqual([]);
    expect(await session()).toMatchObject(persisted);
  },
);
