import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

const sharedClientMocks = vi.hoisted(() => ({
  retainByInstanceId: undefined as
    | ((clientId: string | undefined) => { client: never; release: () => void } | undefined)
    | undefined,
}));

vi.mock("./shared-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared-client.js")>();
  return {
    ...actual,
    retainSharedCodexAppServerClientByInstanceId: (clientId: string | undefined) =>
      sharedClientMocks.retainByInstanceId
        ? sharedClientMocks.retainByInstanceId(clientId)
        : actual.retainSharedCodexAppServerClientByInstanceId(clientId),
  };
});

function nativeStartOptions(sessionFile: string, cwd: string) {
  return {
    params: createParams(sessionFile, cwd),
    cwd,
    dynamicTools: [],
    appServer: createAppServerOptions(),
    mcpServersFingerprintEvaluated: true,
    nativeCodeModeEnabled: false,
    userMcpServersEnabled: false,
  };
}

describe("startOrResumeThread configured MCP ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tempDir = "";

  beforeEach(() => {
    sharedClientMocks.retainByInstanceId = undefined;
    tempDir = tempDirs.make("openclaw-configured-mcp-ownership-");
    resetCodexTestBindingStore();
  });

  afterEach(() => {
    resetThreadLifecycleTestFixtures();
  });

  it("replaces a legacy scheduled binding atomically without disturbing a sibling", async () => {
    const sessionFile = path.join(tempDir, "session-alternating.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-alternating");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-scheduled-old",
      clientId: "client-old",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      configuredMcpOwnershipVersion: 1,
      dynamicToolsFingerprint: "[]",
    });

    const released: string[] = [];
    const oldClient = {
      getInstanceId: () => "client-old",
      request: vi.fn(async (method: string, requestParams: { threadId?: string }) => {
        if (method === "thread/unsubscribe" && requestParams.threadId) {
          released.push(requestParams.threadId);
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(oldClient, { agentDir: workspaceDir });
    await retainCodexAppServerLiveThread(oldClient, "thread-scheduled-old");
    const releaseOldClientLease = vi.fn();
    sharedClientMocks.retainByInstanceId = (clientId) =>
      clientId === "client-old" ? { client: oldClient, release: releaseOldClientLease } : undefined;

    const currentRequest = vi.fn(async (method: string, requestParams?: { threadId?: string }) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "thread/start") {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-scheduled-old",
        });
        expect(released).toHaveLength(0);
        return threadStartResult("thread-native-new");
      }
      if (method === "thread/unsubscribe" && requestParams?.threadId) {
        released.push(requestParams.threadId);
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const currentClient = {
      getInstanceId: () => "client-current",
      request: currentRequest,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(currentClient, { agentDir: workspaceDir });
    const releaseSibling = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(currentClient, "thread-sibling", releaseSibling);
    const common = {
      client: currentClient,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      mcpServersFingerprintEvaluated: true,
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    };

    const next = await startOrResumeThread({
      ...common,
      mcpServersFingerprint: "mcp-v2",
    });
    expect(next).toMatchObject({ threadId: "thread-native-new" });
    expect(released).toEqual(["thread-scheduled-old"]);
    await expect(
      consumeCodexAppServerLiveThread(oldClient, "thread-scheduled-old"),
    ).resolves.toBeUndefined();
    expect(releaseOldClientLease).toHaveBeenCalledOnce();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-native-new",
      clientId: "client-current",
      mcpServersFingerprint: "mcp-v2",
    });

    const sibling = await consumeCodexAppServerLiveThread(currentClient, "thread-sibling");
    expect(sibling).toBeDefined();
    expect(releaseSibling).not.toHaveBeenCalled();
    await sibling?.release("thread-sibling");
    expect(releaseSibling).toHaveBeenCalledWith("thread-sibling");
  });

  it.each(["start", "conflict", "error", "abort"] as const)(
    "preserves the predecessor and cleans only an accepted successor after %s failure",
    async (failure) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-legacy",
        clientId: "client-failure",
        cwd: workspaceDir,
        model: "gpt-5.4-codex",
        modelProvider: "openai",
        configuredMcpOwnershipVersion: 1,
        dynamicToolsFingerprint: "[]",
      });
      const controller = new AbortController();
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "thread/start") {
          if (failure === "start") {
            throw new Error("successor start failed");
          }
          if (failure === "abort") {
            controller.abort("test abort");
          }
          return threadStartResult("thread-uncommitted");
        }
        if (method === "thread/delete" && failure !== "start") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const client = {
        getInstanceId: () => "client-failure",
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
      ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
      const releasePredecessor = vi.fn(async () => undefined);
      await retainCodexAppServerLiveThread(client, "thread-legacy", releasePredecessor);
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        mutate: async (identity, mutation) => {
          if (mutation.kind === "replace-thread") {
            if (failure === "error") {
              throw new Error("lost replacement lease");
            }
            if (failure === "conflict") {
              return false;
            }
          }
          return await testCodexAppServerBindingStore.mutate(identity, mutation);
        },
      };
      await expect(
        startOrResumeThreadImpl({
          bindingStore,
          client,
          ...nativeStartOptions(sessionFile, workspaceDir),
          signal: controller.signal,
        }),
      ).rejects.toThrow(
        {
          start: "successor start failed",
          conflict: "Codex thread binding changed",
          error: "lost replacement lease",
          abort: "test abort",
        }[failure],
      );
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config/read",
        "thread/start",
        ...(failure === "start" ? [] : ["thread/delete"]),
      ]);
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-legacy",
      });
      expect(releasePredecessor).not.toHaveBeenCalled();
      const predecessor = await consumeCodexAppServerLiveThread(client, "thread-legacy");
      expect(predecessor).toBeDefined();
      await predecessor?.release("thread-legacy");
    },
  );
});
