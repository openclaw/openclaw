import path from "node:path";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  CODEX_CONTROL_METHODS as methods,
  type CodexControlMethod,
} from "./app-server/capabilities.js";
import { CODEX_INTERACTIVE_THREAD_SOURCE_KINDS } from "./app-server/protocol.js";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  readCodexAppServerBinding as readBinding,
  testCodexAppServerBindingStore,
  type CodexAppServerBindingStore,
  writeCodexAppServerBinding as writeBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";
import {
  withCodexNativeThreadToolFixture,
  wrapCodexNativeThreadToolRequest,
  type CodexNativeThreadToolFixture,
} from "./native-thread-tool.test-helpers.js";

function expectRequest(
  request: Mock,
  method: CodexControlMethod,
  params: unknown,
  config: unknown = expect.any(Object),
  options: unknown = expect.any(Object),
) {
  expect(request).toHaveBeenCalledWith(config, method, params, options);
}

function expectNoRequest(request: Mock, method: CodexControlMethod) {
  expect(request.mock.calls.map(([, calledMethod]) => calledMethod)).not.toContain(method);
}

function bindThread(threadId: string, sessionId = "session-id") {
  return writeBinding(sessionId, { threadId, cwd: "/tmp/project" });
}

function bindSupervisedThread(threadId: string, fingerprint?: string) {
  return writeBinding("session-id", {
    threadId,
    connectionScope: "supervision",
    supervisionSourceThreadId: "source-thread",
    ...(fingerprint ? { appServerRuntimeFingerprint: fingerprint } : {}),
    cwd: "/tmp/project",
    model: "gpt-5.5",
    modelProvider: "openai",
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
    historyCoveredThrough: new Date().toISOString(),
  });
}
const nativeThread = (id: string, type = "idle") => ({ id, status: { type } });
const fork = (attach = true) => ({
  action: "fork",
  thread_id: "source-thread",
  ...(attach ? {} : { attach: false }),
});
const archive = (thread_id: string) => ({ action: "archive", thread_id, confirm: true });
function archiveRequest(threadId: string, list = () => ({ data: [] })) {
  return vi.fn(async (_config, method: string) => {
    if (method === methods.readThread) {
      return { thread: nativeThread(threadId) };
    }
    if (method === methods.listThreads) {
      return list();
    }
    return {};
  });
}
const privateTranscript = { preview: "private preview", turns: [{ id: "turn-1", items: [] }] };

describe("native Codex thread tool", () => {
  let fixture: CodexNativeThreadToolFixture;

  const test = it.extend<{ nativeFixture: void }>({
    nativeFixture: [
      async ({ task: _task }, use) =>
        withCodexNativeThreadToolFixture(async (current) => {
          fixture = current;
          await use(undefined);
        }),
      { auto: true },
    ],
  });

  async function createTool(
    params: {
      owner?: boolean;
      homeScope?: "agent" | "user";
      omitHomeScope?: boolean;
      supervision?: boolean;
      allowRawTranscripts?: boolean;
      allowWriteControls?: boolean;
      getPluginConfig?: () => unknown;
      request?: Mock;
      sessionId?: string | null;
      modelSelectionLocked?: boolean;
      bindingStore?: CodexAppServerBindingStore;
    } = {},
  ) {
    const storePath = path.join(fixture.root, "sessions", "sessions.json");
    const context: OpenClawPluginToolContext = {
      config: {},
      agentId: "main",
      agentDir: path.join(fixture.root, "agent"),
      workspaceDir: path.join(fixture.root, "workspace"),
      sessionKey: "agent:main:telegram:direct:owner",
      sessionId: params.sessionId === null ? undefined : (params.sessionId ?? "session-id"),
      senderIsOwner: params.owner ?? true,
    };
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: context.sessionKey!,
      entry: {
        sessionId: "session-id",
        updatedAt: 1,
        modelSelectionLocked: params.modelSelectionLocked,
      },
    });
    const pluginConfig: Record<string, unknown> = {};
    if (!params.omitHomeScope) {
      pluginConfig.appServer = { homeScope: params.homeScope ?? "user" };
    }
    if (params.supervision) {
      pluginConfig.supervision = {
        enabled: true,
        ...(params.allowRawTranscripts ? { allowRawTranscripts: true } : {}),
        ...(params.allowWriteControls ? { allowWriteControls: true } : {}),
      };
    }
    return createCodexThreadsTool({
      bindingStore: params.bindingStore ?? testCodexAppServerBindingStore,
      context,
      runtime: createPluginRuntimeMock({
        agent: { session: { resolveStorePath: () => storePath } },
      }),
      getPluginConfig: params.getPluginConfig ?? (() => pluginConfig),
      request: params.request
        ? wrapCodexNativeThreadToolRequest(params.request, fixture.client)
        : undefined,
    });
  }

  function createSupervisedTool(params: Parameters<typeof createTool>[0] = {}) {
    return createTool({ omitHomeScope: true, supervision: true, ...params });
  }

  test("materializes only for owner turns with user-home or supervision access", async () => {
    expect(await createTool()).not.toBeNull();
    expect(await createTool({ owner: false })).toBeNull();
    expect(await createTool({ homeScope: "agent" })).toBeNull();
    expect(await createTool({ omitHomeScope: true, supervision: true })).not.toBeNull();
  });

  test("routes a private supervised binding through the supervision connection with native auth", async () => {
    await bindSupervisedThread(
      "supervised-thread",
      buildCodexSupervisionTestConnectionFingerprint(),
    );
    const request = vi.fn(async () => ({ data: [] }));
    const tool = await createSupervisedTool({
      request,
      modelSelectionLocked: true,
    });

    await tool?.execute("call", { action: "list" });

    expect(request).toHaveBeenCalledWith(
      { supervision: { enabled: true } },
      methods.listThreads,
      expect.any(Object),
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
  });

  test("lists native threads with bounded deterministic parameters", async () => {
    const response = { data: [{ id: "thread-1", status: { type: "idle" } }] };
    const request = vi.fn(async () => response);
    const tool = await createTool({ request, modelSelectionLocked: true });

    const result = await tool?.execute("call", {
      action: "list",
      archived: true,
      cursor: "next-page",
      limit: 12,
      search: "coexistence",
    });

    expect(request).toHaveBeenCalledWith(
      { appServer: { homeScope: "user" } },
      methods.listThreads,
      {
        archived: true,
        cursor: "next-page",
        limit: 12,
        modelProviders: [],
        searchTerm: "coexistence",
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: [...CODEX_INTERACTIVE_THREAD_SOURCE_KINDS],
      },
      expect.objectContaining({
        sessionId: "session-id",
        sessionKey: "agent:main:telegram:direct:owner",
      }),
    );
    expect(result?.details).toEqual(response);
  });

  test("keeps supervised metadata reads available without leaking transcript fields", async () => {
    const thread = { ...nativeThread("thread-1"), name: "Safe title", ...privateTranscript };
    const request = vi.fn(async (_config, method: string) =>
      method === methods.listThreads ? { data: [thread] } : { thread },
    );
    const tool = await createSupervisedTool({ request });

    const listed = await tool?.execute("call", { action: "list" });
    const read = await tool?.execute("call", {
      action: "read",
      thread_id: "thread-1",
      include_turns: false,
    });

    expect(listed?.details).toEqual({
      data: [{ id: "thread-1", name: "Safe title", status: { type: "idle" } }],
    });
    expect(read?.details).toEqual({
      thread: { id: "thread-1", name: "Safe title", status: { type: "idle" } },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test.each([
    {
      action: "read",
      params: { action: "read", thread_id: "thread-1", include_turns: true },
      error: "Codex raw transcript reads are disabled",
    },
    {
      action: "search",
      params: { action: "list", search: "private transcript phrase" },
      error: "search is disabled while raw transcript access is disabled",
    },
  ])("requires raw-transcript permission for $action", async ({ params, error }) => {
    const request = vi.fn();
    const tool = await createSupervisedTool({ request });
    await expect(tool?.execute("call", params)).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
  });

  test("preserves supervised transcript fields when raw reads are explicitly enabled", async () => {
    const response = {
      thread: {
        id: "thread-1",
        preview: "allowed preview",
        turns: [{ id: "turn-1", items: [] }],
      },
    };
    const request = vi.fn(async () => response);
    const tool = await createSupervisedTool({
      allowRawTranscripts: true,
      request,
      modelSelectionLocked: true,
    });

    const result = await tool?.execute("call", {
      action: "read",
      thread_id: "thread-1",
      include_turns: true,
    });

    expectRequest(request, methods.readThread, {
      threadId: "thread-1",
      includeTurns: true,
    });
    expect(result?.details).toEqual(response);
  });

  test("blocks supervised unarchive without write-control permission", async () => {
    const request = vi.fn();
    const tool = await createSupervisedTool({ request });
    await expect(
      tool?.execute("call", { action: "unarchive", thread_id: "thread-1" }),
    ).rejects.toThrow("Codex native thread mutations are disabled");
    expect(request).not.toHaveBeenCalled();
  });

  test("allows supervised native mutations when write controls are explicitly enabled", async () => {
    const request = vi.fn(async (_config, method: string) =>
      method === methods.readThread
        ? { thread: { id: "other-thread", status: { type: "idle" } } }
        : {},
    );
    const tool = await createSupervisedTool({
      allowWriteControls: true,
      request,
      modelSelectionLocked: true,
    });

    await tool?.execute("call", {
      action: "rename",
      thread_id: "thread-1",
      name: "Renamed",
    });

    expectRequest(request, methods.renameThread, {
      threadId: "thread-1",
      name: "Renamed",
    });
  });

  test.each(["fork", "unarchive"] as const)(
    "redacts supervised %s transcripts without raw-read permission",
    async (action) => {
      const isFork = action === "fork";
      const safe = {
        id: isFork ? "forked-thread" : "thread-1",
        name: "Safe title",
        status: { type: isFork ? "idle" : "notLoaded" },
        ...(isFork ? { cwd: "/tmp/project" } : {}),
      };
      const request = vi.fn(async () => ({ thread: { ...safe, ...privateTranscript } }));
      const tool = await createSupervisedTool({
        request,
        allowWriteControls: true,
        ...(isFork ? {} : { modelSelectionLocked: true }),
      });
      const result = await tool?.execute(
        "call",
        isFork ? fork(false) : { action, thread_id: "thread-1" },
      );
      expectRequest(
        request,
        isFork ? methods.forkThread : methods.unarchiveThread,
        isFork
          ? { threadId: "source-thread", threadSource: "user", excludeTurns: true }
          : { threadId: "thread-1" },
      );
      expect(result?.details).toEqual(
        isFork
          ? { action: "fork", sourceThreadId: "source-thread", thread: safe, attached: false }
          : { thread: safe },
      );
      if (isFork) {
        await expect(readBinding("session-id")).resolves.toBeUndefined();
      }
    },
  );

  test("forks a native thread and attaches the fork to the OpenClaw session", async () => {
    const request = vi.fn(async (_config, method: string) =>
      method === methods.readThread
        ? { thread: { id: "source-thread", status: { type: "notLoaded" } } }
        : {
            thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
            model: "gpt-5.5",
            modelProvider: "openai",
          },
    );
    const tool = await createTool({ request, sessionId: null });

    const result = await tool?.execute("call", fork());

    expect(request).toHaveBeenNthCalledWith(
      1,
      { appServer: { homeScope: "user" } },
      methods.readThread,
      { threadId: "source-thread", includeTurns: false },
      expect.any(Object),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      { appServer: { homeScope: "user" } },
      methods.forkThread,
      { threadId: "source-thread", threadSource: "user", excludeTurns: true },
      expect.any(Object),
    );
    await expect(
      readBinding("session-id", { agentDir: path.join(fixture.root, "agent") }),
    ).resolves.toMatchObject({
      threadId: "forked-thread",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      modelProvider: "openai",
      historyCoveredThrough: expect.any(String),
    });
    expect(result?.details).toMatchObject({
      action: "fork",
      sourceThreadId: "source-thread",
      attached: true,
    });
  });

  test.each([
    [
      "a different thread id",
      { thread: nativeThread("different-thread") },
      "returned a different thread than requested",
    ],
    ["a malformed response", { thread: null }, "returned an invalid thread/read response"],
    ["a missing status", { thread: { id: "source-thread" } }, "unless it is idle or not loaded"],
  ] as const)("refuses to attach a fork after %s", async (_scenario, response, error) => {
    await bindThread("source-thread");
    const request = vi.fn(async () => response);
    const tool = await createTool({ request });

    await expect(tool?.execute("call", fork())).rejects.toThrow(error);
    expect(request).toHaveBeenCalledOnce();
    expectRequest(
      request,
      methods.readThread,
      { threadId: "source-thread", includeTurns: false },
      expect.anything(),
      expect.anything(),
    );
    expectNoRequest(request, methods.forkThread);
  });

  test("reports a conflict when a fork cannot attach to the current generation", async () => {
    const request = vi.fn(async (_config, method: string) =>
      method === methods.readThread
        ? { thread: { id: "source-thread", status: { type: "idle" } } }
        : { thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } } },
    );
    const mutate = vi.spyOn(testCodexAppServerBindingStore, "mutate").mockResolvedValueOnce(false);
    try {
      await expect((await createTool({ request }))?.execute("call", fork())).rejects.toThrow(
        "binding changed before the fork could be attached",
      );
    } finally {
      mutate.mockRestore();
    }
  });

  test("does not change a locked session binding via fork", async () => {
    await bindThread("bound-thread");
    const request = vi.fn();
    const tool = await createTool({ request, modelSelectionLocked: true });
    await expect(tool?.execute("call", fork())).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(request).not.toHaveBeenCalled();
    await expect(readBinding("session-id")).resolves.toMatchObject({
      threadId: "bound-thread",
    });
  });

  test.each([
    {
      action: "fork",
      params: fork(),
      error: "Supervised Codex forks must stay detached",
    },
    {
      action: "archive",
      params: { action: "archive", thread_id: "bound-thread", confirm: true },
      error: "Refusing to replace supervised Codex thread",
    },
  ])("preserves private supervision ownership during $action", async ({ params, error }) => {
    await bindSupervisedThread("bound-thread");
    const request = vi.fn();
    const tool = await createSupervisedTool({
      allowWriteControls: true,
      request,
    });
    await expect(tool?.execute("call", params)).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
    await expect(readBinding("session-id")).resolves.toMatchObject({
      threadId: "bound-thread",
      connectionScope: "supervision",
    });
  });

  test("rechecks the live connection config before attaching a fork", async () => {
    let pluginConfig: unknown = { appServer: { homeScope: "user" } };
    const request = vi.fn();
    const tool = await createTool({ request, getPluginConfig: () => pluginConfig });
    pluginConfig = { supervision: { enabled: true, allowWriteControls: true } };

    await expect(tool?.execute("call", fork())).rejects.toThrow(
      "Supervised Codex forks must stay detached",
    );
    expect(request).not.toHaveBeenCalled();
  });

  test("rejects an attached fork when the session lock changes during its native read", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const request = vi.fn(async (_config, method: string) => {
      if (method === methods.readThread) {
        entered.resolve();
        await release.promise;
        return { thread: { id: "source-thread", status: { type: "idle" } } };
      }
      throw new Error("Fork must not be dispatched after the session lock changes");
    });
    const tool = await createTool({ request });
    const running = expect(tool?.execute("call", fork())).rejects.toThrow("ownership changed");
    await entered.promise;
    try {
      await upsertSessionEntry({
        agentId: "main",
        storePath: path.join(fixture.root, "sessions", "sessions.json"),
        sessionKey: "agent:main:telegram:direct:owner",
        entry: { sessionId: "session-id", updatedAt: 2, modelSelectionLocked: true },
      });
    } finally {
      release.resolve();
    }
    await running;
    expect(request).toHaveBeenCalledOnce();
  });

  test.each([
    { status: "active", error: "cannot archive an active Codex thread" },
    { status: "systemError", error: "cannot verify that the Codex thread is idle" },
  ])("refuses to archive a bound $status thread", async ({ status, error }) => {
    await bindThread("thread-1");
    const request = vi.fn(async (_config, method: string) =>
      method === methods.readThread ? { thread: nativeThread("thread-1", status) } : {},
    );
    const tool = await createTool({ request });
    await expect(tool?.execute("call", archive("thread-1"))).rejects.toThrow(error);
    expect(request).toHaveBeenCalledOnce();
    expectRequest(
      request,
      methods.readThread,
      { threadId: "thread-1", includeTurns: false },
      expect.anything(),
      expect.anything(),
    );
    expectNoRequest(request, methods.archiveThread);
  });

  test("archives an idle bound thread and clears its attachment", async () => {
    await bindThread("idle-thread");
    const request = archiveRequest("idle-thread");
    const tool = await createTool({ request });
    await tool?.execute("call", archive("idle-thread"));
    expectRequest(
      request,
      methods.readThread,
      { threadId: "idle-thread", includeTurns: false },
      { appServer: { homeScope: "user" } },
    );
    expectRequest(
      request,
      methods.archiveThread,
      { threadId: "idle-thread" },
      { appServer: { homeScope: "user" } },
    );
    await expect(readBinding("session-id")).resolves.toBeUndefined();
  });

  test("reserves archive ownership before cold imports let a later binding mutation run", async () => {
    await bindThread("original-thread");
    const request = vi.fn(async (_config, method: string) => {
      if (method === methods.readThread) {
        return { thread: { id: "archive-target", status: { type: "idle" } } };
      }
      return method === methods.listThreads ? { data: [] } : {};
    });
    const tool = await createTool({ request });
    if (!tool) {
      throw new Error("expected the owner native thread tool");
    }
    const archiving = tool.execute("call", archive("archive-target"));
    const lateAttachment = bindThread("archive-target");
    try {
      await Promise.all([
        expect(lateAttachment).rejects.toThrow(
          "binding mutation blocked while a native archive is in progress",
        ),
        expect(archiving).resolves.toMatchObject({
          details: { action: "archive", threadId: "archive-target" },
        }),
      ]);
      await expect(readBinding("session-id")).resolves.toMatchObject({
        threadId: "original-thread",
      });
    } finally {
      await Promise.allSettled([archiving, lateAttachment]);
    }
  });

  test("rechecks a binding attached while archive waits for its ownership fence", async () => {
    let fenced = false;
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      withThreadArchiveFence: async (run) => {
        if (!fenced) {
          fenced = true;
          await bindThread("newly-bound-thread");
        }
        return await testCodexAppServerBindingStore.withThreadArchiveFence(run);
      },
    };
    const request = vi.fn(async () => ({}));
    const tool = await createTool({ bindingStore, request, modelSelectionLocked: true });

    await expect(tool?.execute("call", archive("newly-bound-thread"))).rejects.toThrow(
      MODEL_SELECTION_LOCKED_MESSAGE,
    );

    expect(request).not.toHaveBeenCalled();
    await expect(readBinding("session-id")).resolves.toMatchObject({
      threadId: "newly-bound-thread",
    });
  });

  test.each([
    { scenario: "another session owns the thread", error: "owned by another OpenClaw session" },
    { scenario: "descendant enumeration fails", error: "descendant lookup failed" },
  ])("rejects archive when $scenario", async ({ scenario, error }) => {
    const owned = scenario === "another session owns the thread";
    if (owned) {
      await bindThread("current-thread");
      await bindThread("other-thread", "other-session");
    }
    const threadId = owned ? "other-thread" : "parent-thread";
    const request = archiveRequest(threadId, () => {
      throw new Error("descendant lookup failed");
    });
    const tool = await createTool({ request });
    await expect(tool?.execute("call", archive(threadId))).rejects.toThrow(error);
    expectNoRequest(request, methods.archiveThread);
    if (owned) {
      expect(request).toHaveBeenCalledOnce();
      await expect(readBinding("other-session")).resolves.toMatchObject({
        threadId: "other-thread",
      });
    }
  });

  test("rejects archive when an archived descendant is owned by another session", async () => {
    const archived = true;
    await bindThread("owned-descendant", "other-session");
    const request = vi.fn(async (_config, method: string, requestParams?: unknown) => {
      if (method === methods.readThread) {
        return {
          thread: {
            id: (requestParams as { threadId: string }).threadId,
            status: { type: "idle" },
          },
        };
      }
      if (method === methods.listThreads) {
        return {
          data:
            (requestParams as { archived: boolean }).archived === archived
              ? [{ id: "owned-descendant" }]
              : [],
        };
      }
      return {};
    });
    const tool = await createTool({ request });

    await expect(tool?.execute("call", archive("parent-thread"))).rejects.toThrow(
      "spawned descendant is owned by an OpenClaw session",
    );

    expectRequest(
      request,
      methods.listThreads,
      {
        ancestorThreadId: "parent-thread",
        archived,
        limit: 100,
        sortKey: "created_at",
        sortDirection: "desc",
        useStateDbOnly: true,
      },
      expect.anything(),
      expect.anything(),
    );
    expectNoRequest(request, methods.archiveThread);
  });
});
