import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
  subscribeCodexCatalogEvents,
} from "./session-catalog-events.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";

const cleanups: Array<() => Promise<void>> = [];
let fixtureId = 0;

function nativeThread(overrides: Partial<CodexThread> = {}) {
  return {
    id: "thread-1",
    projectId: null,
    sessionId: "session-1",
    forkedFromId: null,
    name: "Native thread",
    preview: "First user request",
    ephemeral: false,
    source: "cli" as const,
    cwd: "/workspace/persisted",
    modelProvider: "openai",
    cliVersion: CODEX_APP_SERVER_VERSION,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    path: null,
    createdAt: 100,
    updatedAt: 100,
    recencyAt: 100,
    status: { type: "idle" as const },
    turns: [],
    ...overrides,
  };
}

function resumeResponse(thread: ReturnType<typeof nativeThread>) {
  return {
    thread,
    model: "fixture-model",
    modelProvider: "runtime-provider",
    serviceTier: null,
    cwd: "/workspace/runtime",
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: null,
    reasoningEffort: null,
  };
}

async function fixture(sameSecond = false, overflow = false, evicted = false) {
  const options: CodexAppServerStartOptions = {
    transport: "websocket",
    command: "codex",
    args: ["app-server"],
    url: `wss://catalog-settings-${++fixtureId}.example.test/codex`,
    authToken: "synthetic-settings-token",
    headers: {},
  };
  const inventory = [
    nativeThread({ recencyAt: evicted ? 0 : sameSecond ? 200 : 100 }),
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
            : sameSecond
              ? inventory.toReversed()
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
              ...(offset + data.length < matching.length
                ? { nextCursor: String(offset + data.length) }
                : {}),
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
  await (overflow ? b.client : a.client).request(
    "thread/list",
    { limit: 1 },
    { catalogPreview: true },
  );
  methods.length = 0;
  await observeCodexCatalogClient(a.client, { startOptions: options });
  await observeCodexCatalogClient(b.client, { startOptions: options });
  const homeId = await codexCatalogResidentHomeKey({ startOptions: options });
  const index = new CodexCatalogIndex({
    homeId,
    readNative: async (params: CodexThreadListParams) =>
      projectCodexCatalogPage(
        // Overflow queries still have a native reader after the live settings source closes.
        await (overflow ? b.client : a.client).request("thread/list", params, {
          catalogPreview: true,
        }),
        { sanitize: sanitizeTerminalText },
      ),
    assertCurrent: () => {},
  });
  cleanups.push(() => index.close());
  await index.initialize();
  return { a, b, index, inventory, methods, homeId };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

describe("Codex catalog live settings", () => {
  it.each([false, true])(
    "keeps live resume settings authoritative for overflow cwd queries (evicted: %s)",
    async (evicted) => {
      const { a, index } = await fixture(false, true, evicted);
      if (evicted) {
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
      await resumeCodexAppServerThread({
        client: a.client,
        abandonClient: vi.fn(async () => {}),
        request: { threadId: "thread-1", excludeTurns: true },
        timeoutMs: 1_000,
      });
      expect(await findThread("/workspace/runtime")).toMatchObject({
        threadId: "thread-1",
        cwd: "/workspace/runtime",
        modelProvider: "runtime-provider",
      });
      expect(await findThread("/workspace/persisted")).toBeUndefined();
      if (!evicted) {
        expect((await index.list({ cwd: "/workspace/runtime" })).sessions).toEqual([
          expect.objectContaining({
            threadId: "thread-1",
            cwd: "/workspace/runtime",
            modelProvider: "runtime-provider",
          }),
        ]);
        expect(
          (await index.list({ cwd: "/workspace/persisted" })).sessions.some(
            (session) => session.threadId === "thread-1",
          ),
        ).toBe(false);
      }
      a.client.close();
      expect((await index.list({ cwd: "/workspace/runtime" })).sessions).toEqual([]);
      expect(await findThread("/workspace/persisted")).toMatchObject({
        threadId: "thread-1",
        modelProvider: "openai",
      });
      if (!evicted) {
        expect((await index.list({ cwd: "/workspace/persisted" })).sessions).toContainEqual(
          expect.objectContaining({ threadId: "thread-1", modelProvider: "openai" }),
        );
      }
    },
  );

  it("keeps another connection's active status on overflow pages until it closes", async () => {
    const { a, index, inventory } = await fixture(false, true);
    inventory[0]!.status = { type: "notLoaded" };
    a.send({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    });
    const expected = { status: "active", activeFlags: ["waitingOnApproval"] };
    expect(
      (await index.list({})).sessions.find((row) => row.threadId === "thread-1"),
    ).toMatchObject(expected);
    expect(
      (await index.list({ cwd: "/workspace/persisted" })).sessions.find(
        (row) => row.threadId === "thread-1",
      ),
    ).toMatchObject(expected);
    a.client.close();
    const closed = (await index.list({ cwd: "/workspace/persisted" })).sessions.find(
      (row) => row.threadId === "thread-1",
    );
    expect(closed?.status).toBe("notLoaded");
    expect(closed?.activeFlags).toBeUndefined();
  });

  it("publishes acknowledged resume settings before returning and keeps stale native metadata behind the live overlay", async () => {
    const { a, index, inventory, methods } = await fixture();
    const abandonClient = vi.fn(async () => {});
    await resumeCodexAppServerThread({
      client: a.client,
      abandonClient,
      request: { threadId: "thread-1", excludeTurns: true },
      timeoutMs: 1_000,
    });
    expect((await index.list({ cwd: "/workspace/runtime" })).sessions).toEqual([
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
    expect((await index.list({ cwd: "/workspace/runtime" })).sessions[0]).toMatchObject({
      cwd: "/workspace/runtime",
      modelProvider: "runtime-provider",
    });
    a.client.close();
    expect((await index.list({ cwd: "/workspace/runtime" })).sessions).toEqual([]);
    expect(
      (await index.list({ cwd: "/workspace/persisted" })).sessions.some(
        (row) => row.threadId === "thread-1",
      ),
    ).toBe(true);
    expect(abandonClient).not.toHaveBeenCalled();
  });

  it("uses settings notifications in filtering and preserves equivalent open-source settings without a lookup", async () => {
    const { a, b, index, methods } = await fixture();
    const event = {
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: { cwd: "/workspace/live", modelProvider: "live-provider" },
      },
    };
    a.send(event);
    b.send(event);
    b.client.close();
    expect((await index.list({ cwd: "/workspace/live" })).sessions).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/workspace/live",
        modelProvider: "live-provider",
      }),
    ]);
    expect(methods).toEqual(["thread/list"]);
    a.client.close();
    expect((await index.list({ cwd: "/workspace/live" })).sessions).toEqual([]);
  });

  it("refreshes native recency on turn start before turn completion", async () => {
    const { a, index, inventory, methods } = await fixture();
    expect((await index.list({})).sessions[0]?.threadId).toBe("other");
    inventory[0]!.recencyAt = 300;
    inventory[0]!.updatedAt = 300;
    a.send({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress", startedAt: 300, items: [] },
      },
    });
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions[0]).toMatchObject({
        threadId: "thread-1",
        recencyAt: 300,
      });
    });
    expect(methods).toEqual(["thread/list", "thread/read"]);
  });

  it("withdraws settings only when their supporting source reports notLoaded", async () => {
    const { a, b, index, methods } = await fixture();
    a.send({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: { cwd: "/workspace/live", modelProvider: "live-provider" },
      },
    });
    const unloaded = {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "notLoaded" } },
    };
    b.send(unloaded);
    expect((await index.list({ cwd: "/workspace/live" })).sessions[0]?.threadId).toBe("thread-1");
    a.send(unloaded);
    expect((await index.list({ cwd: "/workspace/live" })).sessions).toEqual([]);
    expect(
      (await index.list({})).sessions.find((row) => row.threadId === "thread-1"),
    ).toMatchObject({ cwd: "/workspace/persisted", modelProvider: "openai" });
    expect(a.client.getCloseError()).toBeUndefined();
    expect(methods).toEqual(["thread/list"]);
  });

  it("moves a newly started turn ahead of siblings within the same native timestamp second", async () => {
    const { a, index, methods } = await fixture(true);
    expect((await index.list({})).sessions.map((row) => row.threadId)).toEqual([
      "other",
      "thread-1",
    ]);
    a.send({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "same-second", startedAt: 200, items: [] } },
    });
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions.map((row) => row.threadId)).toEqual([
        "thread-1",
        "other",
      ]);
    });
    expect((await index.list({})).sessions.map((row) => row.recencyAt)).toEqual([200, 200]);
    expect(methods).toEqual(["thread/list", "thread/read"]);
  });

  it("keeps a successful resume subscribed when a catalog observer fails", async () => {
    const { a, homeId } = await fixture();
    const observer = vi.fn(async () => {
      throw new Error("catalog observer failed");
    });
    const stop = subscribeCodexCatalogEvents(homeId, () => {}, { onResume: observer });
    const abandonClient = vi.fn(async () => {});
    try {
      await expect(
        resumeCodexAppServerThread({
          client: a.client,
          abandonClient,
          request: { threadId: "thread-1", excludeTurns: true },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ thread: { id: "thread-1" }, cwd: "/workspace/runtime" });
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
      const { a, index, inventory } = await fixture();
      a.send({
        method: "thread/settings/updated",
        params: {
          threadId: "thread-1",
          threadSettings: { cwd: "/workspace/live", modelProvider: "live-provider" },
        },
      });
      expect((await index.list({ cwd: "/workspace/live" })).sessions).toHaveLength(1);
      a.send({ method, params: { threadId: "thread-1" } });
      expect((await index.list({ cwd: "/workspace/live" })).sessions).toEqual([]);
      await index.upsertThread(inventory[0]!);
      expect((await index.list({ cwd: "/workspace/live" })).sessions).toEqual([]);
      expect(
        (await index.list({})).sessions.find((row) => row.threadId === "thread-1"),
      ).toMatchObject({ cwd: "/workspace/persisted", modelProvider: "openai" });
    },
  );
});
