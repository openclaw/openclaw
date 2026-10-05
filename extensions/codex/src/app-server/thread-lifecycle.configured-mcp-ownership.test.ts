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
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle-run.js";
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

function scheduledStartOptions(sessionFile: string, cwd: string) {
  return {
    params: createParams(sessionFile, cwd),
    cwd,
    dynamicTools: [],
    appServer: createAppServerOptions(),
    configuredMcpOwnershipVersion: 1 as const,
    mcpServersFingerprintEvaluated: true,
    nativeCodeModeEnabled: false,
    userMcpServersEnabled: false,
  };
}

describe("startOrResumeThread — configured MCP ownership", () => {
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

  it("atomically alternates ordinary and scheduled ownership for a persistent named session without dual bindings", async () => {
    const sessionFile = path.join(tempDir, "session-alternating.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-alternating");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-ordinary-old",
      clientId: "client-old",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      mcpServersFingerprint: "mcp-v1",
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
    await retainCodexAppServerLiveThread(oldClient, "thread-ordinary-old");
    const releaseOldClientLease = vi.fn();
    sharedClientMocks.retainByInstanceId = (clientId) =>
      clientId === "client-old" ? { client: oldClient, release: releaseOldClientLease } : undefined;

    const successorIds = ["thread-scheduled-v1", "thread-ordinary-new", "thread-scheduled-v2"];
    const currentRequest = vi.fn(async (method: string, requestParams?: { threadId?: string }) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "thread/start") {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId:
            successorIds.length === 3
              ? "thread-ordinary-old"
              : successorIds.length === 2
                ? "thread-scheduled-v1"
                : "thread-ordinary-new",
        });
        expect(released).toHaveLength(
          successorIds.length === 3 ? 0 : successorIds.length === 2 ? 1 : 2,
        );
        return threadStartResult(successorIds.shift()!);
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

    const transitions = [
      { threadId: "thread-scheduled-v1", version: 1 as const },
      { threadId: "thread-ordinary-new", version: undefined },
      { threadId: "thread-scheduled-v2", version: 1 as const },
    ];
    let previousId = "thread-ordinary-old";
    const expectedReleases: string[] = [];
    for (const transition of transitions) {
      const next = await startOrResumeThread({
        ...common,
        ...(transition.version
          ? { configuredMcpOwnershipVersion: transition.version }
          : { mcpServersFingerprint: "mcp-v2" }),
      });
      expect(next).toMatchObject({ threadId: transition.threadId });
      expect(next.configuredMcpOwnershipVersion).toBe(transition.version);
      expectedReleases.push(previousId);
      expect(released).toEqual(expectedReleases);
      await expect(
        consumeCodexAppServerLiveThread(
          previousId === "thread-ordinary-old" ? oldClient : currentClient,
          previousId,
        ),
      ).resolves.toBeUndefined();
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: transition.threadId,
        clientId: "client-current",
      });
      if (transition.threadId !== "thread-scheduled-v2") {
        await retainCodexAppServerLiveThread(
          currentClient,
          next.threadId,
          undefined,
          next.liveThreadConfigFingerprint,
        );
      }
      previousId = next.threadId;
    }
    expect(releaseOldClientLease).toHaveBeenCalledOnce();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-scheduled-v2",
      configuredMcpOwnershipVersion: 1,
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
        mcpServersFingerprint: "mcp-v1",
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
          ...scheduledStartOptions(sessionFile, workspaceDir),
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
