import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { CODEX_INTERACTIVE_THREAD_SOURCE_KINDS } from "./app-server/protocol.js";
import {
  readCodexAppServerBinding,
  resolveCodexAppServerBindingPath,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("native Codex thread tool", () => {
  let root: string;
  let sessionFile: string;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-codex-threads-");
    sessionFile = path.join(root, "sessions", "session-id.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function createTool(params?: {
    owner?: boolean;
    homeScope?: "agent" | "user";
    request?: ReturnType<typeof vi.fn>;
  }) {
    const context: OpenClawPluginToolContext = {
      config: {},
      agentId: "main",
      agentDir: path.join(root, "agent"),
      workspaceDir: path.join(root, "workspace"),
      sessionKey: "agent:main:telegram:direct:owner",
      sessionId: "session-id",
      senderIsOwner: params?.owner ?? true,
    };
    const runtime = createPluginRuntimeMock({
      agent: {
        session: {
          getSessionEntry: () => ({ sessionId: "session-id", sessionFile, updatedAt: Date.now() }),
          resolveStorePath: () => path.join(root, "sessions", "sessions.json"),
          resolveSessionFilePath: () => sessionFile,
        },
      },
    });
    return createCodexThreadsTool({
      context,
      runtime,
      getPluginConfig: () => ({ appServer: { homeScope: params?.homeScope ?? "user" } }),
      request: params?.request as never,
    });
  }

  it("materializes only for owner turns in shared user-home mode", () => {
    expect(createTool()).not.toBeNull();
    expect(createTool({ owner: false })).toBeNull();
    expect(createTool({ homeScope: "agent" })).toBeNull();
  });

  it("lists native threads with bounded deterministic parameters", async () => {
    const response = { data: [{ id: "thread-1", status: { type: "idle" } }] };
    const request = vi.fn(async () => response);
    const tool = createTool({ request });

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

  it("forks a native thread and attaches the fork to the OpenClaw session", async () => {
    const request = vi.fn(async () => ({
      thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      model: "gpt-5.5",
      modelProvider: "openai",
    }));
    const tool = createTool({ request });

    const result = await tool?.execute("call-2", {
      action: "fork",
      thread_id: "source-thread",
    });

    expect(request).toHaveBeenCalledWith(
      { appServer: { homeScope: "user" } },
      CODEX_CONTROL_METHODS.forkThread,
      { threadId: "source-thread" },
      expect.any(Object),
    );
    await expect(
      readCodexAppServerBinding(sessionFile, { agentDir: path.join(root, "agent") }),
    ).resolves.toMatchObject({
      threadId: "forked-thread",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      modelProvider: "openai",
    });
    expect(result?.details).toMatchObject({
      action: "fork",
      sourceThreadId: "source-thread",
      attached: true,
    });
  });

  it("refuses to archive the active thread bound to this OpenClaw session", async () => {
    await writeCodexAppServerBinding(sessionFile, {
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
  });

  it("archives an idle bound thread and clears its attachment", async () => {
    await writeCodexAppServerBinding(sessionFile, {
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
    await expect(fs.access(resolveCodexAppServerBindingPath(sessionFile))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

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
  ])(
    "routes $action through the typed Codex control method",
    async ({ params, method, requestParams }) => {
      const request = vi.fn(async () => ({ thread: { id: "thread-1" } }));
      const tool = createTool({ request });

      await tool?.execute("call-5", params);

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        method,
        requestParams,
        expect.any(Object),
      );
    },
  );
});
