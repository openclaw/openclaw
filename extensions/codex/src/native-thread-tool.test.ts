import path from "node:path";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { aroundEach, describe, expect, it, vi, type Mock } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { CODEX_INTERACTIVE_THREAD_SOURCE_KINDS } from "./app-server/protocol.js";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
  type CodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";
import {
  withCodexNativeThreadToolFixture,
  writeNativeThreadToolBinding,
  wrapCodexNativeThreadToolRequest,
  type CodexNativeThreadToolFixture,
} from "./native-thread-tool.test-helpers.js";

function expectRequest(
  request: Mock,
  method: string,
  params: unknown,
  config: unknown = expect.any(Object),
  options: unknown = expect.any(Object),
) {
  expect(request).toHaveBeenCalledWith(config, method, params, options);
}

function expectNoRequest(request: Mock, method: string) {
  expect(request).not.toHaveBeenCalledWith(
    expect.anything(),
    method,
    expect.anything(),
    expect.anything(),
  );
}

function nativeThread(id: string, status = "idle") {
  return { id, status: { type: status } };
}

const archiveParams = (thread_id: string) => ({ action: "archive", thread_id, confirm: true });

function privateThread(id: string, status = "idle") {
  return {
    ...nativeThread(id, status),
    name: "Safe title",
    preview: "private preview",
    turns: [{ id: "turn-1", items: [] }],
  };
}

function threadRequest(threadId: string, status = "idle", listDescendants = false) {
  return vi.fn(async (_config, method: string) => {
    if (method === CODEX_CONTROL_METHODS.readThread) {
      return { thread: nativeThread(threadId, status) };
    }
    return listDescendants && method === CODEX_CONTROL_METHODS.listThreads ? { data: [] } : {};
  });
}

function supervisedBinding(threadId: string) {
  return {
    threadId,
    connectionScope: "supervision" as const,
    supervisionSourceThreadId: "source-thread",
    cwd: "/tmp/project",
    model: "gpt-5.5",
    modelProvider: "openai",
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
    historyCoveredThrough: new Date().toISOString(),
  } satisfies Parameters<typeof writeCodexAppServerBinding>[1];
}

const supervised = { omitHomeScope: true, supervision: true };
const writable = { ...supervised, allowWriteControls: true };
const userHome = { appServer: { homeScope: "user" } };

describe("native Codex thread tool", () => {
  let fixture: CodexNativeThreadToolFixture;

  aroundEach(async (runTest) => {
    await withCodexNativeThreadToolFixture(async (current) => {
      fixture = current;
      await runTest();
    });
  });

  async function createTool(params?: {
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
  }) {
    const context: OpenClawPluginToolContext = {
      config: {},
      agentId: "main",
      agentDir: path.join(fixture.root, "agent"),
      workspaceDir: path.join(fixture.root, "workspace"),
      sessionKey: "agent:main:telegram:direct:owner",
      sessionId: params?.sessionId === null ? undefined : (params?.sessionId ?? "session-id"),
      senderIsOwner: params?.owner ?? true,
    };
    await upsertSessionEntry({
      agentId: "main",
      storePath: path.join(fixture.root, "sessions", "sessions.json"),
      sessionKey: context.sessionKey!,
      entry: {
        sessionId: "session-id",
        updatedAt: 1,
        modelSelectionLocked: params?.modelSelectionLocked,
      },
    });
    const runtime = createPluginRuntimeMock({
      agent: {
        session: {
          resolveStorePath: () => path.join(fixture.root, "sessions", "sessions.json"),
        },
      },
    });
    return createCodexThreadsTool({
      bindingStore: params?.bindingStore ?? testCodexAppServerBindingStore,
      context,
      runtime,
      getPluginConfig:
        params?.getPluginConfig ??
        (() => ({
          ...(params?.omitHomeScope
            ? {}
            : { appServer: { homeScope: params?.homeScope ?? "user" } }),
          ...(params?.supervision
            ? {
                supervision: {
                  enabled: true,
                  ...(params.allowRawTranscripts ? { allowRawTranscripts: true } : {}),
                  ...(params.allowWriteControls ? { allowWriteControls: true } : {}),
                },
              }
            : {}),
        })),
      request: params?.request
        ? wrapCodexNativeThreadToolRequest(params.request, fixture.client)
        : undefined,
    });
  }

  it("declares native-home access but denies nonowner calls before native requests", async () => {
    expect(await createTool()).not.toBeNull();
    const request = vi.fn();
    const nonowner = await createTool({ owner: false, request });
    await expect(nonowner!.execute("denied", { action: "list" })).rejects.toThrow(
      "owner-authorized sender",
    );
    expect(request).not.toHaveBeenCalled();
    expect(await createTool({ homeScope: "agent" })).toBeNull();
    expect(await createTool({ homeScope: "agent", owner: false })).toBeNull();
    expect(await createTool({ omitHomeScope: true, supervision: true })).not.toBeNull();
  });

  it("routes a private supervised binding through the supervision connection with native auth", async () => {
    await writeCodexAppServerBinding("session-id", {
      ...supervisedBinding("supervised-thread"),
      appServerRuntimeFingerprint: buildCodexSupervisionTestConnectionFingerprint(),
    });
    const request = vi.fn(async () => ({ data: [] }));
    const tool = await createTool({ ...supervised, request, modelSelectionLocked: true });

    await tool?.execute("call-supervised-list", { action: "list" });

    expect(request).toHaveBeenCalledWith(
      { supervision: { enabled: true } },
      CODEX_CONTROL_METHODS.listThreads,
      expect.any(Object),
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
  });

  it("lists native threads with bounded deterministic parameters", async () => {
    const response = { data: [{ id: "thread-1", status: { type: "idle" } }] };
    const request = vi.fn(async () => response);
    const tool = await createTool({ request, modelSelectionLocked: true });

    const result = await tool?.execute("call-1", {
      action: "list",
      archived: true,
      cursor: "next-page",
      limit: 12,
      search: "coexistence",
    });

    expect(request).toHaveBeenCalledWith(
      { appServer: { homeScope: "user" } },
      CODEX_CONTROL_METHODS.listThreads,
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

  it("keeps supervised metadata reads available without leaking transcript fields", async () => {
    const request = vi.fn(async (_config, method: string) =>
      method === CODEX_CONTROL_METHODS.listThreads
        ? { data: [privateThread("thread-1")] }
        : { thread: privateThread("thread-1") },
    );
    const tool = await createTool({ ...supervised, request });

    const listed = await tool?.execute("call-safe-list", { action: "list" });
    const read = await tool?.execute("call-safe-read", {
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

  it.each([
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
    const tool = await createTool({ ...supervised, request });
    await expect(tool?.execute("call-blocked-transcript", params)).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves supervised transcript fields when raw reads are explicitly enabled", async () => {
    const response = {
      thread: {
        id: "thread-1",
        preview: "allowed preview",
        turns: [{ id: "turn-1", items: [] }],
      },
    };
    const request = vi.fn(async () => response);
    const tool = await createTool({
      ...supervised,
      allowRawTranscripts: true,
      request,
      modelSelectionLocked: true,
    });

    const result = await tool?.execute("call-allowed-read", {
      action: "read",
      thread_id: "thread-1",
      include_turns: true,
    });

    expectRequest(request, CODEX_CONTROL_METHODS.readThread, {
      threadId: "thread-1",
      includeTurns: true,
    });
    expect(result?.details).toEqual(response);
  });

  it("blocks supervised unarchive without write-control permission", async () => {
    const request = vi.fn();
    const tool = await createTool({ ...supervised, request });

    await expect(
      tool?.execute("call-blocked-write", {
        action: "unarchive",
        thread_id: "thread-1",
      }),
    ).rejects.toThrow("Codex native thread mutations are disabled");
    expect(request).not.toHaveBeenCalled();
  });

  it("allows supervised native mutations when write controls are explicitly enabled", async () => {
    const request = threadRequest("other-thread");
    const tool = await createTool({
      ...writable,
      request,
      modelSelectionLocked: true,
    });

    await tool?.execute("call-allowed-write", {
      action: "rename",
      thread_id: "thread-1",
      name: "Renamed",
    });

    expectRequest(request, CODEX_CONTROL_METHODS.renameThread, {
      threadId: "thread-1",
      name: "Renamed",
    });
  });

  it.each(["fork", "unarchive"] as const)(
    "redacts %s transcripts when raw reads are disabled",
    async (action) => {
      const fork = action === "fork";
      const thread = {
        ...nativeThread(fork ? "forked-thread" : "thread-1", fork ? "idle" : "notLoaded"),
        name: "Safe title",
        ...(fork ? { cwd: "/tmp/project" } : {}),
      };
      const request = vi.fn(async () => ({
        thread: {
          ...thread,
          preview: "private preview",
          turns: [{ id: "turn-1", items: [] }],
        },
      }));
      const tool = await createTool({ ...writable, request, modelSelectionLocked: !fork });
      const sourceThreadId = fork ? "source-thread" : "thread-1";
      const result = await tool?.execute("redacted", {
        action,
        thread_id: sourceThreadId,
        ...(fork ? { attach: false } : {}),
      });
      expectRequest(
        request,
        fork ? CODEX_CONTROL_METHODS.forkThread : CODEX_CONTROL_METHODS.unarchiveThread,
        {
          threadId: sourceThreadId,
          ...(fork ? { threadSource: "user", excludeTurns: true } : {}),
        },
      );
      expect(result?.details).toEqual({
        thread,
        ...(fork ? { action, sourceThreadId, attached: false } : {}),
      });
      if (fork) {
        await expect(readCodexAppServerBinding("session-id")).resolves.toBeUndefined();
      }
    },
  );

  it("forks a native thread and attaches the fork to the OpenClaw session", async () => {
    const request = vi.fn(async (_config, method: string) =>
      method === CODEX_CONTROL_METHODS.readThread
        ? { thread: nativeThread("source-thread", "notLoaded") }
        : {
            thread: { ...nativeThread("forked-thread"), cwd: "/tmp/project" },
            model: "gpt-5.5",
            modelProvider: "openai",
          },
    );
    const tool = await createTool({ request, sessionId: null });

    const result = await tool?.execute("call-2", {
      action: "fork",
      thread_id: "source-thread",
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      { appServer: { homeScope: "user" } },
      CODEX_CONTROL_METHODS.readThread,
      { threadId: "source-thread", includeTurns: false },
      expect.any(Object),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      { appServer: { homeScope: "user" } },
      CODEX_CONTROL_METHODS.forkThread,
      { threadId: "source-thread", threadSource: "user", excludeTurns: true },
      expect.any(Object),
    );
    await expect(
      readCodexAppServerBinding("session-id", { agentDir: path.join(fixture.root, "agent") }),
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

  it.each([
    {
      action: "fork",
      name: "a different thread id",
      response: { thread: { id: "different-thread", status: { type: "idle" } } },
      error: "returned a different thread than requested",
    },
    {
      action: "fork",
      name: "a malformed response",
      response: { thread: null },
      error: "returned an invalid thread/read response",
    },
    {
      action: "fork",
      name: "a missing status",
      response: { thread: { id: "source-thread" } },
      error: "unless it is idle or not loaded",
    },
    {
      action: "archive",
      name: "an active thread",
      response: { thread: nativeThread("source-thread", "active") },
      readOnly: true,
      error: "cannot archive an active Codex thread",
    },
    {
      action: "archive",
      name: "a system-error status",
      response: { thread: nativeThread("source-thread", "systemError") },
      error: "cannot verify that the Codex thread is idle",
    },
  ])("refuses $action after $name", async ({ action, response, error, readOnly }) => {
    await writeNativeThreadToolBinding("source-thread");
    const request = vi.fn(async (_config, method: string) =>
      readOnly && method !== CODEX_CONTROL_METHODS.readThread ? {} : response,
    );
    const tool = await createTool({ request });

    await expect(
      tool?.execute("call-unsafe-thread", {
        action,
        thread_id: "source-thread",
        ...(action === "archive" ? { confirm: true } : {}),
      }),
    ).rejects.toThrow(error);
    expectNoRequest(
      request,
      action === "fork" ? CODEX_CONTROL_METHODS.forkThread : CODEX_CONTROL_METHODS.archiveThread,
    );
  });

  it("reports a conflict when a fork cannot attach to the current generation", async () => {
    const request = vi.fn(async (_config, method: string) =>
      method === CODEX_CONTROL_METHODS.readThread
        ? { thread: nativeThread("source-thread") }
        : { thread: { ...nativeThread("forked-thread"), cwd: "/tmp/project" } },
    );
    const mutate = vi.spyOn(testCodexAppServerBindingStore, "mutate").mockResolvedValueOnce(false);
    try {
      await expect(
        (await createTool({ request }))?.execute("call-conflict", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("binding changed before the fork could be attached");
    } finally {
      mutate.mockRestore();
    }
  });

  it("does not change a locked session binding via fork", async () => {
    await writeNativeThreadToolBinding("bound-thread");
    const request = vi.fn();
    const tool = await createTool({ request, modelSelectionLocked: true });
    await expect(
      tool?.execute("call-locked-mutation", {
        action: "fork",
        thread_id: "source-thread",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(request).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
      threadId: "bound-thread",
    });
  });

  it.each([
    {
      action: "fork",
      params: { action: "fork", thread_id: "source-thread" },
      error: "Supervised Codex forks must stay detached",
    },
    {
      action: "archive",
      params: { action: "archive", thread_id: "bound-thread", confirm: true },
      error: "Refusing to replace supervised Codex thread",
    },
  ])("preserves private supervision ownership during $action", async ({ params, error }) => {
    await writeCodexAppServerBinding("session-id", supervisedBinding("bound-thread"));
    const request = vi.fn();
    const tool = await createTool({ ...writable, request });
    await expect(tool?.execute("call-supervised-mutation", params)).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
      threadId: "bound-thread",
      connectionScope: "supervision",
    });
  });

  it("rechecks the live connection config before attaching a fork", async () => {
    let pluginConfig: unknown = { appServer: { homeScope: "user" } };
    const request = vi.fn();
    const tool = await createTool({ request, getPluginConfig: () => pluginConfig });
    pluginConfig = { supervision: { enabled: true, allowWriteControls: true } };

    await expect(
      tool?.execute("call-live-supervision-fork", {
        action: "fork",
        thread_id: "source-thread",
      }),
    ).rejects.toThrow("Supervised Codex forks must stay detached");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an attached fork when the session lock changes during its native read", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const request = vi.fn(async (_config, method: string) => {
      if (method === CODEX_CONTROL_METHODS.readThread) {
        entered.resolve();
        await release.promise;
        return { thread: nativeThread("source-thread") };
      }
      throw new Error("Fork must not be dispatched after the session lock changes");
    });
    const tool = await createTool({ request });
    const running = expect(
      tool?.execute("changed-lock", { action: "fork", thread_id: "source-thread" }),
    ).rejects.toThrow("ownership changed");
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

  it("archives an idle bound thread and clears its attachment", async () => {
    await writeNativeThreadToolBinding("idle-thread");
    const request = threadRequest("idle-thread", "idle", true);
    const tool = await createTool({ request });

    await tool?.execute("call-4", archiveParams("idle-thread"));

    expectRequest(
      request,
      CODEX_CONTROL_METHODS.readThread,
      { threadId: "idle-thread", includeTurns: false },
      userHome,
    );
    expectRequest(
      request,
      CODEX_CONTROL_METHODS.archiveThread,
      { threadId: "idle-thread" },
      userHome,
    );
    await expect(readCodexAppServerBinding("session-id")).resolves.toBeUndefined();
  });

  it("reserves archive ownership before cold imports let a later binding mutation run", async () => {
    await writeNativeThreadToolBinding("original-thread");
    const request = threadRequest("archive-target", "idle", true);
    const tool = await createTool({ request });
    if (!tool) {
      throw new Error("expected the owner native thread tool");
    }
    const archiving = tool.execute("call-archive-admission", archiveParams("archive-target"));
    const lateAttachment = writeNativeThreadToolBinding("archive-target");
    try {
      await Promise.all([
        expect(lateAttachment).rejects.toThrow(
          "binding mutation blocked while a native archive is in progress",
        ),
        expect(archiving).resolves.toMatchObject({
          details: { action: "archive", threadId: "archive-target" },
        }),
      ]);
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "original-thread",
      });
    } finally {
      await Promise.allSettled([archiving, lateAttachment]);
    }
  });

  it("rechecks a binding attached while archive waits for its ownership fence", async () => {
    let fenced = false;
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      withThreadArchiveFence: async (run) => {
        if (!fenced) {
          fenced = true;
          await writeNativeThreadToolBinding("newly-bound-thread");
        }
        return await testCodexAppServerBindingStore.withThreadArchiveFence(run);
      },
    };
    const request = vi.fn(async () => ({}));
    const tool = await createTool({ bindingStore, request, modelSelectionLocked: true });

    await expect(
      tool?.execute("call-raced-locked-archive", archiveParams("newly-bound-thread")),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);

    expect(request).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
      threadId: "newly-bound-thread",
    });
  });

  it("rejects archive when another OpenClaw session owns the thread", async () => {
    await writeNativeThreadToolBinding("current-thread");
    await writeNativeThreadToolBinding("other-thread", "other-session");
    const request = threadRequest("other-thread");
    const tool = await createTool({ request });

    await expect(
      tool?.execute("call-owned-archive", archiveParams("other-thread")),
    ).rejects.toThrow("owned by another OpenClaw session");

    expect(request).toHaveBeenCalledOnce();
    expectNoRequest(request, CODEX_CONTROL_METHODS.archiveThread);
    await expect(readCodexAppServerBinding("other-session")).resolves.toMatchObject({
      threadId: "other-thread",
    });
  });

  it.each([true])(
    "rejects archive when a spawned descendant is owned by an OpenClaw session (archived=%s)",
    async (archived) => {
      await writeNativeThreadToolBinding("owned-descendant", "other-session");
      const request = vi.fn(async (_config, method: string, requestParams?: unknown) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return {
            thread: nativeThread((requestParams as { threadId: string }).threadId),
          };
        }
        if (method === CODEX_CONTROL_METHODS.listThreads) {
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

      await expect(
        tool?.execute("call-descendant-owned-archive", archiveParams("parent-thread")),
      ).rejects.toThrow("spawned descendant is owned by an OpenClaw session");

      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.listThreads,
        {
          ancestorThreadId: "parent-thread",
          archived,
          limit: 100,
          sortKey: "created_at",
          sortDirection: "desc",
          useStateDbOnly: true,
        },
        expect.anything(),
      );
      expectNoRequest(request, CODEX_CONTROL_METHODS.archiveThread);
    },
  );

  it("fails closed when native descendant enumeration errors", async () => {
    const request = vi.fn(async (_config, method: string) => {
      if (method === CODEX_CONTROL_METHODS.readThread) {
        return { thread: nativeThread("parent-thread") };
      }
      if (method === CODEX_CONTROL_METHODS.listThreads) {
        throw new Error("descendant lookup failed");
      }
      return {};
    });
    const tool = await createTool({ request });

    await expect(
      tool?.execute("call-descendant-error-archive", archiveParams("parent-thread")),
    ).rejects.toThrow("descendant lookup failed");
    expectNoRequest(request, CODEX_CONTROL_METHODS.archiveThread);
  });
});
