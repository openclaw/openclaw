import fs from "node:fs/promises";
import path from "node:path";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { CODEX_INTERACTIVE_THREAD_SOURCE_KINDS } from "./app-server/protocol.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";

describe("native Codex thread tool", () => {
  let root: string;
  let sessionFile: string;

  async function withFixture(run: () => void | Promise<void>): Promise<void> {
    await withTempDir("openclaw-codex-threads-", async (tempRoot) => {
      root = tempRoot;
      sessionFile = path.join(root, "sessions", "session-id.jsonl");
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.writeFile(sessionFile, "");
      resetCodexTestBindingStore();
      registerCodexTestSessionIdentity(
        "session-id",
        "session-id",
        "agent:main:telegram:direct:owner",
      );
      await run();
    });
  }

  function createTool(params?: {
    owner?: boolean;
    homeScope?: "agent" | "user";
    omitHomeScope?: boolean;
    supervision?: boolean;
    allowRawTranscripts?: boolean;
    allowWriteControls?: boolean;
    request?: ReturnType<typeof vi.fn>;
    sessionId?: string | null;
    modelSelectionLocked?: boolean;
  }) {
    const context: OpenClawPluginToolContext = {
      config: {},
      agentId: "main",
      agentDir: path.join(root, "agent"),
      workspaceDir: path.join(root, "workspace"),
      sessionKey: "agent:main:telegram:direct:owner",
      sessionId: params?.sessionId === null ? undefined : (params?.sessionId ?? "session-id"),
      senderIsOwner: params?.owner ?? true,
    };
    const runtime = createPluginRuntimeMock({
      agent: {
        session: {
          getSessionEntry: () => ({
            sessionId: "session-id",
            sessionFile,
            updatedAt: Date.now(),
            modelSelectionLocked: params?.modelSelectionLocked,
          }),
          resolveStorePath: () => path.join(root, "sessions", "sessions.json"),
          resolveSessionFilePath: () => sessionFile,
        },
      },
    });
    return createCodexThreadsTool({
      bindingStore: testCodexAppServerBindingStore,
      context,
      runtime,
      getPluginConfig: () => ({
        ...(params?.omitHomeScope ? {} : { appServer: { homeScope: params?.homeScope ?? "user" } }),
        ...(params?.supervision
          ? {
              supervision: {
                enabled: true,
                ...(params.allowRawTranscripts ? { allowRawTranscripts: true } : {}),
                ...(params.allowWriteControls ? { allowWriteControls: true } : {}),
              },
            }
          : {}),
      }),
      request: params?.request as never,
    });
  }

  it("materializes only for owner turns with user-home or supervision access", () =>
    withFixture(() => {
      expect(createTool()).not.toBeNull();
      expect(createTool({ owner: false })).toBeNull();
      expect(createTool({ homeScope: "agent" })).toBeNull();
      expect(createTool({ omitHomeScope: true, supervision: true })).not.toBeNull();
    }));

  it("routes a private supervised binding through the supervision connection with native auth", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "supervised-thread",
        connectionScope: "supervision",
        supervisionSourceThreadId: "source-thread",
        cwd: "/tmp/project",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        historyCoveredThrough: new Date().toISOString(),
      });
      const request = vi.fn(async () => ({ data: [] }));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        request,
        modelSelectionLocked: true,
      });

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
    }));

  it("lists native threads with bounded deterministic parameters", () =>
    withFixture(async () => {
      const response = { data: [{ id: "thread-1", status: { type: "idle" } }] };
      const request = vi.fn(async () => response);
      const tool = createTool({ request, modelSelectionLocked: true });

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
    }));

  it("keeps supervised metadata reads available without leaking transcript fields", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.listThreads
          ? {
              data: [
                {
                  id: "thread-1",
                  name: "Safe title",
                  preview: "private preview",
                  status: { type: "idle" },
                  turns: [{ id: "turn-1", items: [] }],
                },
              ],
            }
          : {
              thread: {
                id: "thread-1",
                name: "Safe title",
                preview: "private preview",
                status: { type: "idle" },
                turns: [{ id: "turn-1", items: [] }],
              },
            },
      );
      const tool = createTool({ omitHomeScope: true, supervision: true, request });

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
    }));

  it("requires explicit supervision permission for raw transcript reads", () =>
    withFixture(async () => {
      const request = vi.fn();
      const tool = createTool({ omitHomeScope: true, supervision: true, request });

      await expect(
        tool?.execute("call-blocked-read", {
          action: "read",
          thread_id: "thread-1",
          include_turns: true,
        }),
      ).rejects.toThrow("Codex raw transcript reads are disabled");
      expect(request).not.toHaveBeenCalled();
    }));

  it("preserves supervised transcript fields when raw reads are explicitly enabled", () =>
    withFixture(async () => {
      const response = {
        thread: {
          id: "thread-1",
          preview: "allowed preview",
          turns: [{ id: "turn-1", items: [] }],
        },
      };
      const request = vi.fn(async () => response);
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowRawTranscripts: true,
        request,
      });

      const result = await tool?.execute("call-allowed-read", {
        action: "read",
        thread_id: "thread-1",
        include_turns: true,
      });

      expect(result?.details).toEqual(response);
    }));

  it.each([
    {
      action: "fork",
      params: { action: "fork", thread_id: "thread-1", attach: false },
    },
    {
      action: "rename",
      params: { action: "rename", thread_id: "thread-1", name: "Renamed" },
    },
    {
      action: "archive",
      params: { action: "archive", thread_id: "thread-1", confirm: true },
    },
    {
      action: "unarchive",
      params: { action: "unarchive", thread_id: "thread-1" },
    },
  ])("blocks supervised $action without write-control permission", ({ params }) =>
    withFixture(async () => {
      const request = vi.fn();
      const tool = createTool({ omitHomeScope: true, supervision: true, request });

      await expect(tool?.execute("call-blocked-write", params)).rejects.toThrow(
        "Codex native thread mutations are disabled",
      );
      expect(request).not.toHaveBeenCalled();
    }),
  );

  it("allows supervised native mutations when write controls are explicitly enabled", () =>
    withFixture(async () => {
      const request = vi.fn(async () => ({}));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      await tool?.execute("call-allowed-write", {
        action: "rename",
        thread_id: "thread-1",
        name: "Renamed",
      });

      expect(request).toHaveBeenCalledWith(
        expect.any(Object),
        CODEX_CONTROL_METHODS.renameThread,
        { threadId: "thread-1", name: "Renamed" },
        expect.any(Object),
      );
    }));

  it("forks a native thread and attaches the fork to the OpenClaw session", () =>
    withFixture(async () => {
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
        model: "gpt-5.5",
        modelProvider: "openai",
      }));
      const tool = createTool({ request, sessionId: null });

      const result = await tool?.execute("call-2", {
        action: "fork",
        thread_id: "source-thread",
      });

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.forkThread,
        { threadId: "source-thread", threadSource: "user" },
        expect.any(Object),
      );
      await expect(
        readCodexAppServerBinding("session-id", { agentDir: path.join(root, "agent") }),
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
    }));

  it("reports a conflict when a fork cannot attach to the current generation", () =>
    withFixture(async () => {
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      }));
      const mutate = vi
        .spyOn(testCodexAppServerBindingStore, "mutate")
        .mockResolvedValueOnce(false);
      try {
        await expect(
          createTool({ request })?.execute("call-conflict", {
            action: "fork",
            thread_id: "source-thread",
          }),
        ).rejects.toThrow("binding changed before the fork could be attached");
      } finally {
        mutate.mockRestore();
      }
    }));

  it("does not replace a locked session binding with an attached fork", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      }));
      const tool = createTool({ request, modelSelectionLocked: true });

      await expect(
        tool?.execute("call-locked-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);

      expect(request).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));

  it("does not replace a private supervised binding even if the public lock is unavailable", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        connectionScope: "supervision",
        supervisionSourceThreadId: "source-thread",
        cwd: "/tmp/project",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        historyCoveredThrough: new Date().toISOString(),
      });
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      }));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      await expect(
        tool?.execute("call-supervised-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("Refusing to replace supervised Codex thread");

      expect(request).not.toHaveBeenCalled();
    }));

  it("allows a detached fork without changing a locked session binding", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      }));
      const tool = createTool({ request, modelSelectionLocked: true });

      const result = await tool?.execute("call-detached-fork", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.forkThread,
        { threadId: "source-thread", threadSource: "user" },
        expect.any(Object),
      );
      expect(result?.details).toMatchObject({ attached: false });
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));

  it("refuses to archive the active thread bound to this OpenClaw session", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "active-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async (_config, method: string) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return { thread: { id: "active-thread", status: { type: "active" } } };
        }
        return {};
      });
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-3", {
          action: "archive",
          thread_id: "active-thread",
          confirm: true,
        }),
      ).rejects.toThrow("cannot archive the Codex thread active in this OpenClaw session");
      expect(request).not.toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.archiveThread,
        expect.anything(),
        expect.anything(),
      );
    }));

  it("archives an idle bound thread and clears its attachment", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "idle-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async (_config, method: string) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return { thread: { id: "idle-thread", status: { type: "idle" } } };
        }
        return {};
      });
      const tool = createTool({ request });

      await tool?.execute("call-4", {
        action: "archive",
        thread_id: "idle-thread",
        confirm: true,
      });

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.archiveThread,
        { threadId: "idle-thread" },
        expect.any(Object),
      );
      await expect(readCodexAppServerBinding("session-id")).resolves.toBeUndefined();
    }));

  it("does not archive and clear the thread bound to a locked session", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => ({}));
      const tool = createTool({ request, modelSelectionLocked: true });

      await expect(
        tool?.execute("call-locked-archive", {
          action: "archive",
          thread_id: "bound-thread",
          confirm: true,
        }),
      ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);

      expect(request).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));

  it("does not archive a private supervised binding even if the public lock is unavailable", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        connectionScope: "supervision",
        supervisionSourceThreadId: "source-thread",
        cwd: "/tmp/project",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        historyCoveredThrough: new Date().toISOString(),
      });
      const request = vi.fn(async () => ({}));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      await expect(
        tool?.execute("call-supervised-archive", {
          action: "archive",
          thread_id: "bound-thread",
          confirm: true,
        }),
      ).rejects.toThrow("Refusing to replace supervised Codex thread");

      expect(request).not.toHaveBeenCalled();
    }));

  it("allows a locked session to archive a different thread", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => ({}));
      const tool = createTool({ request, modelSelectionLocked: true });

      await tool?.execute("call-other-archive", {
        action: "archive",
        thread_id: "other-thread",
        confirm: true,
      });

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.archiveThread,
        { threadId: "other-thread" },
        expect.any(Object),
      );
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));

  it.each([
    {
      action: "read" as const,
      params: { action: "read", thread_id: "thread-1", include_turns: true },
      method: CODEX_CONTROL_METHODS.readThread,
      requestParams: { threadId: "thread-1", includeTurns: true },
    },
    {
      action: "rename" as const,
      params: { action: "rename", thread_id: "thread-1", name: "Shared thread" },
      method: CODEX_CONTROL_METHODS.renameThread,
      requestParams: { threadId: "thread-1", name: "Shared thread" },
    },
    {
      action: "unarchive" as const,
      params: { action: "unarchive", thread_id: "thread-1" },
      method: CODEX_CONTROL_METHODS.unarchiveThread,
      requestParams: { threadId: "thread-1" },
    },
  ])("routes $action through the typed Codex control method", ({ params, method, requestParams }) =>
    withFixture(async () => {
      const request = vi.fn(async () => ({ thread: { id: "thread-1" } }));
      const tool = createTool({ request, modelSelectionLocked: true });

      await tool?.execute("call-5", params);

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        method,
        requestParams,
        expect.any(Object),
      );
    }),
  );
});
