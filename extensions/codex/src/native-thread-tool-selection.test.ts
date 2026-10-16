import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread as consumeThread,
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread as hasLiveThread,
  isCodexAppServerLiveThreadClaimed as isThreadClaimed,
  retainCodexAppServerLiveThread as retainThread,
} from "./app-server/client-runtime.js";
import { createLazyCodexAppServerBindingStore } from "./app-server/session-binding-store.js";
import {
  createCodexTestBindingStateStore,
  createCodexTestBindingStore,
  type CodexAppServerBindingIdentity,
} from "./app-server/session-binding.test-helpers.js";
import { createClientHarness } from "./app-server/test-support.js";
import type { codexControlRequest } from "./command-rpc.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";

const sharedClients = vi.hoisted(() => ({
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
  createIsolatedCodexAppServerClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => sharedClients);

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);

const ownershipChanged = (pending: Promise<unknown>) =>
  expect(pending).rejects.toThrow("native thread ownership changed");

async function createSession() {
  const identity = {
    kind: "session" as const,
    agentId: "main",
    sessionId: "session-id",
    sessionKey: "agent:main:selection",
  };
  const session = {
    sessionId: identity.sessionId,
    updatedAt: 1,
    modelSelectionLocked: false,
    inputTokens: 0,
  };
  const storePath = path.join(tempDirs.make("codex-thread-selection-"), "sessions.json");
  await upsertSessionEntry({ ...identity, storePath, entry: session });
  const runtime = createPluginRuntimeMock({
    agent: { session: { resolveStorePath: () => storePath } },
  });
  return { identity, session, storePath, runtime };
}

describe("native Codex thread selection", () => {
  it.each(["connection", "session", "config"] as const)(
    "revalidates a native request after a %s change",
    async (change) => {
      const bindingStore = createCodexTestBindingStore();
      const { identity, session, storePath, runtime } = await createSession();
      const binding = { threadId: "bound-thread", cwd: "/synthetic/workspace" };
      await bindingStore.mutate(identity, { kind: "set", binding });
      let config: OpenClawConfig = {};
      const dispatch = vi.fn(() => ({ data: [] }));
      const request = vi.fn<typeof codexControlRequest>();
      request.mockImplementation(async (_config, _method, _params, options = {}) => {
        await bindingStore.mutate(identity, {
          kind: "set",
          binding: {
            ...binding,
            ...(change === "connection" ? { appServerRuntimeFingerprint: "replacement" } : {}),
            historyCoveredThrough: "2026-09-16T12:00:00Z",
            continuityCalibration: { promptChars: 2000, inputTokens: 200 },
          },
        });
        session.inputTokens = 200;
        if (change === "session") {
          session.sessionId = "replacement-session";
        } else if (change === "config") {
          config = { ...config };
        }
        await upsertSessionEntry({ ...identity, storePath, entry: session });
        await options.assertCurrentAsync?.();
        options.assertCurrent!();
        return dispatch();
      });
      const tool = createCodexThreadsTool({
        bindingStore,
        runtime,
        context: {
          ...identity,
          agentDir: "/synthetic/agent",
          workspaceDir: binding.cwd,
          senderIsOwner: true,
          getRuntimeConfig: () => config,
        },
        getPluginConfig: () => ({ appServer: { homeScope: "user" } }),
        request,
      });

      const pending = tool!.execute("selection-change", { action: "list" });
      await ownershipChanged(pending);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
});

describe("native Codex fork ownership", () => {
  let f: Awaited<ReturnType<typeof createFork>>;
  beforeEach(async () => {
    f = await createFork();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    f.forkResponse.resolve(f.response);
    f.client.close();
    sharedClients.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClients.releaseLeasedSharedCodexAppServerClient.mockReset();
    sharedClients.retireSharedCodexAppServerClientIfCurrent.mockReset();
  });

  async function createFork() {
    const bindingStore = createLazyCodexAppServerBindingStore(createCodexTestBindingStateStore());
    const sessionFixture = await createSession();
    const { identity, runtime } = sessionFixture;
    let invocationCurrent = true;
    const forkWritten = createDeferred<void>();
    const response = { thread: { id: "forked-thread" } };
    const forkResponse = createDeferred<unknown>();
    const unsubscribed: string[] = [];
    const { client } = createClientHarness({
      onWrite: (line, send) => {
        const { id, method, params } = JSON.parse(line) as {
          id: number;
          method: string;
          params: { threadId: string };
        };
        if (method === "thread/fork") {
          forkWritten.resolve();
          void forkResponse.promise.then(
            (result) => send({ id, result }),
            (error: unknown) => send({ id, error }),
          );
        } else if (method === "thread/read") {
          send({ id, result: { thread: { id: params.threadId, status: { type: "notLoaded" } } } });
        } else if (method === "thread/unsubscribe") {
          unsubscribed.push(params.threadId);
          send({ id, result: {} });
        }
      },
    });
    ensureCodexAppServerClientRuntime(client, { agentDir: "/synthetic/agent" });
    sharedClients.getLeasedSharedCodexAppServerClient.mockResolvedValue(client);
    const binding = {
      threadId: "bound-thread",
      clientId: client.getInstanceId(),
      cwd: "/synthetic/workspace",
    };
    await bindingStore.mutate(identity, { kind: "set", binding });
    const tool = (sessionBound = true, requestTimeoutMs = 60_000) =>
      createCodexThreadsTool({
        bindingStore,
        runtime,
        context: {
          config: {},
          ...(sessionBound ? identity : {}),
          agentDir: "/synthetic/agent",
          workspaceDir: binding.cwd,
          senderIsOwner: true,
          assertInvocationCurrent: () => {
            if (!invocationCurrent) {
              throw new Error("Codex native thread ownership changed; invocation ended.");
            }
          },
        },
        getPluginConfig: () => ({ appServer: { homeScope: "user", requestTimeoutMs } }),
      })!;
    return {
      bindingStore,
      ...sessionFixture,
      binding,
      client,
      forkWritten,
      forkResponse,
      response,
      unsubscribed,
      setBinding: (threadId: string) =>
        bindingStore.mutate(identity, { kind: "set", binding: { ...binding, threadId } }),
      expectBound: () => {
        expect(bindingStore.read(identity)).toMatchObject({
          threadId: "forked-thread",
          clientId: client.getInstanceId(),
        });
        expect(hasLiveThread(client, "forked-thread")).toBe(true);
      },
      expectAvailable: async (threadId: string) => {
        await expect(client.request("thread/read", { threadId })).resolves.toMatchObject({
          thread: { id: threadId },
        });
        expect(sharedClients.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
      },
      fork: (callId: string, attached = true, timeoutMs = 60_000) =>
        tool(attached, timeoutMs).execute(callId, {
          action: "fork",
          thread_id: "source-thread",
          ...(attached ? {} : { attach: false }),
        }),
      expectRetired: async () => {
        await expect(client.request("thread/read", { threadId: "source-thread" })).rejects.toThrow(
          "closed",
        );
        expect(
          sharedClients.retireSharedCodexAppServerClientIfCurrent,
        ).toHaveBeenCalledExactlyOnceWith(client);
        expect(unsubscribed).toEqual([]);
        expect(bindingStore.read(identity)).toEqual(binding);
      },
      revokeInvocation: () => {
        invocationCurrent = false;
      },
    };
  }

  it("retains the fork for the next turn without releasing the running turn", async () => {
    const { client, binding, forkResponse, response, unsubscribed } = f;
    await retainThread(client, binding.threadId);
    const running = await consumeThread(client, binding.threadId);
    forkResponse.resolve(response);

    await expect(f.fork("attach-fork")).resolves.toMatchObject({
      details: { attached: true },
    });

    f.expectBound();
    expect(isThreadClaimed(client, binding.threadId)).toBe(true);
    expect(unsubscribed).toEqual([]);
    await running!.release(binding.threadId);
    expect(unsubscribed).toEqual([binding.threadId]);
    expect(hasLiveThread(client, "forked-thread")).toBe(true);
  });

  it("preserves a replacement binding while the native fork is in flight", async () => {
    const operation = f.fork("stale-fork");
    const rejected = ownershipChanged(operation);
    await f.forkWritten.promise;
    const replacement = { ...f.binding, threadId: "replacement-thread" };
    await f.setBinding(replacement.threadId);
    f.forkResponse.resolve(f.response);
    await rejected;
    expect(f.bindingStore.read(f.identity)).toEqual(replacement);
    expect(f.unsubscribed).toEqual(["forked-thread"]);
    expect(hasLiveThread(f.client, "forked-thread")).toBe(false);
  });

  it("rejects a retained fork when its invocation ends during the binding write", async () => {
    const mutate = f.bindingStore.mutate.bind(f.bindingStore);
    const bindingWrite = vi.spyOn(f.bindingStore, "mutate").mockImplementationOnce((...args) => {
      expect(hasLiveThread(f.client, "forked-thread")).toBe(true);
      // The lazy facade awaits the binding owner before its guarded write.
      const pending = mutate(...args);
      f.revokeInvocation();
      return pending;
    });
    f.forkResponse.resolve(f.response);
    await ownershipChanged(f.fork("revoked-fork-write"));

    expect(bindingWrite).toHaveBeenCalledOnce();
    expect(f.bindingStore.read(f.identity)).toEqual(f.binding);
    expect(f.unsubscribed).toEqual(["forked-thread"]);
    expect(hasLiveThread(f.client, "forked-thread")).toBe(false);
    await f.expectAvailable(f.binding.threadId);
  });

  it("reports a committed fork without replacing a successor binding", async () => {
    const withLease = f.bindingStore.withLease.bind(f.bindingStore);
    const settledLease = vi
      .spyOn(f.bindingStore, "withLease")
      .mockImplementationOnce(
        async <T>(identity: CodexAppServerBindingIdentity, run: () => Promise<T>): Promise<T> => {
          const result = await withLease(identity, run);
          f.expectBound();
          await expect(f.setBinding("successor-thread")).resolves.toBe(true);
          return result;
        },
      );
    f.forkResponse.resolve(f.response);
    await expect(f.fork("committed-fork")).resolves.toMatchObject({
      details: { attached: true, thread: { id: "forked-thread" } },
    });

    expect(settledLease).toHaveBeenCalledOnce();
    expect(f.bindingStore.read(f.identity)?.threadId).toBe("successor-thread");
    expect(hasLiveThread(f.client, "forked-thread")).toBe(true);
    expect(f.unsubscribed).toEqual([]);
  });

  it.each([
    { failure: "timeout", error: "timed out", response: undefined },
    { failure: "assembly", error: "failed to read the new fork", response: undefined },
    { failure: "response", error: "invalid thread/fork response", response: {} },
    { failure: "response", error: "did not include a thread id", response: { thread: {} } },
  ])("retires the written fork client after $error", async ({ failure, error, response }) => {
    const pending = f.fork("failed-fork", false, failure === "timeout" ? 100 : 60_000);
    const rejected = expect(pending).rejects.toThrow(error);
    await f.forkWritten.promise;
    if (failure === "assembly") {
      f.forkResponse.reject({ code: -32600, message: error });
    } else if (failure === "response") {
      f.forkResponse.resolve(response);
    }
    await rejected;
    await f.expectRetired();
  });

  it("keeps the client available when fork authority changes before dispatch", async () => {
    sharedClients.getLeasedSharedCodexAppServerClient
      .mockResolvedValueOnce(f.client)
      .mockImplementationOnce(async () => {
        f.session.modelSelectionLocked = true;
        await upsertSessionEntry({
          ...f.identity,
          storePath: f.storePath,
          entry: f.session,
        });
        return f.client;
      });
    await ownershipChanged(f.fork("unwritten-fork"));
    await f.expectAvailable("source-thread");
    expect(f.unsubscribed).toEqual([]);
  });
});
