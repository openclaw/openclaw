import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  retainCodexAppServerLiveThread,
} from "./app-server/client-runtime.js";
import { CODEX_APP_SERVER_OVERLOADED_ERROR_CODE } from "./app-server/rpc-error.js";
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
  isCodexAppServerStartSelectionChangedError: () => false,
}));

vi.mock("./app-server/shared-client.js", () => sharedClients);

describe("native Codex thread selection", () => {
  it.each([
    "metadata",
    "thread",
    "connection",
    "session",
    "model-lock",
    "config",
    "owner",
  ] as const)("revalidates a native request after a %s change", async (change) => {
    const bindingStore = createCodexTestBindingStore();
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-id",
      sessionKey: "agent:main:selection",
    };
    const binding = { threadId: "bound-thread", cwd: "/synthetic/workspace" };
    await bindingStore.mutate(identity, { kind: "set", binding });
    let config: OpenClawConfig = {};
    let ownerCurrent = true;
    const session = {
      sessionId: identity.sessionId,
      modelSelectionLocked: false,
      inputTokens: 0,
    };
    const runtime = createPluginRuntimeMock({
      agent: {
        session: {
          getSessionEntry: () => ({ ...session, updatedAt: Date.now() }),
        },
      },
    });
    const dispatch = vi.fn(() => ({ data: [] }));
    const request = vi.fn<typeof codexControlRequest>();
    request.mockImplementation(async (_config, _method, _params, options = {}) => {
      await bindingStore.mutate(identity, {
        kind: "set",
        binding: {
          ...binding,
          threadId: change === "thread" ? "replacement-thread" : binding.threadId,
          ...(change === "connection" ? { appServerRuntimeFingerprint: "replacement" } : {}),
          historyCoveredThrough: "2026-09-16T12:00:00Z",
          continuityCalibration: { promptChars: 2000, inputTokens: 200 },
        },
      });
      session.inputTokens = 200;
      if (change === "session") {
        session.sessionId = "replacement-session";
      } else if (change === "model-lock") {
        session.modelSelectionLocked = true;
      } else if (change === "config") {
        config = { ...config };
      } else if (change === "owner") {
        ownerCurrent = false;
      }
      expect(options.assertCurrent).toBeTypeOf("function");
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
        assertInvocationCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("native thread ownership changed: continuation closed");
          }
        },
        getRuntimeConfig: () => config,
      },
      getPluginConfig: () => ({ appServer: { homeScope: "user" } }),
      request,
    });

    const pending = tool!.execute("selection-change", { action: "list" });
    if (change === "metadata") {
      await expect(pending).resolves.toMatchObject({ details: { data: [] } });
      expect(dispatch).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toThrow("native thread ownership changed");
      expect(dispatch).not.toHaveBeenCalled();
    }
  });
});

describe("native Codex fork ownership", () => {
  async function withFork(run: (fixture: Awaited<ReturnType<typeof createFork>>) => Promise<void>) {
    const fixture = await createFork();
    try {
      await run(fixture);
    } finally {
      fixture.forkResponse.resolve(fixture.response);
      fixture.harness.client.close();
      sharedClients.getLeasedSharedCodexAppServerClient.mockReset();
      sharedClients.releaseLeasedSharedCodexAppServerClient.mockReset();
      sharedClients.retireSharedCodexAppServerClientIfCurrent.mockReset();
    }
  }

  async function createFork() {
    const bindingStore = createLazyCodexAppServerBindingStore(createCodexTestBindingStateStore());
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-id",
      sessionKey: "agent:main:fork-ownership",
    };
    const session = { sessionId: identity.sessionId, modelSelectionLocked: false };
    let invocationCurrent = true;
    const forkWritten = createDeferred<void>();
    const response = {
      thread: { id: "forked-thread", cwd: "/synthetic/workspace", status: { type: "idle" } },
      model: "gpt-5.5",
      modelProvider: "openai",
    };
    const forkResponse = createDeferred<unknown>();
    const unsubscribed: string[] = [];
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as {
          id: number;
          method: string;
          params: { threadId: string };
        };
        if (request.method === "thread/fork") {
          forkWritten.resolve();
          void forkResponse.promise.then(
            (result) => send({ id: request.id, result }),
            (error: unknown) => send({ id: request.id, error }),
          );
        } else if (request.method === "thread/read") {
          send({
            id: request.id,
            result: { thread: { id: request.params.threadId, status: { type: "notLoaded" } } },
          });
        } else if (request.method === "thread/unsubscribe") {
          unsubscribed.push(request.params.threadId);
          send({ id: request.id, result: {} });
        }
      },
    });
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/synthetic/agent" });
    sharedClients.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);
    const binding = {
      threadId: "bound-thread",
      clientId: harness.client.getInstanceId(),
      cwd: "/synthetic/workspace",
    };
    await bindingStore.mutate(identity, { kind: "set", binding });
    const tool = (sessionBound = true, requestTimeoutMs = 60_000) =>
      createCodexThreadsTool({
        bindingStore,
        runtime: createPluginRuntimeMock({
          agent: { session: { getSessionEntry: () => ({ ...session, updatedAt: Date.now() }) } },
        }),
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
      identity,
      session,
      binding,
      harness,
      forkWritten,
      forkResponse,
      response,
      unsubscribed,
      tool,
      revokeInvocation: () => {
        invocationCurrent = false;
      },
    };
  }

  it("retains the fork for the next turn without releasing the running turn", () =>
    withFork(async (fixture) => {
      const { harness, bindingStore, identity, binding, forkResponse, response, unsubscribed } =
        fixture;
      await retainCodexAppServerLiveThread(harness.client, binding.threadId);
      const running = await consumeCodexAppServerLiveThread(harness.client, binding.threadId);
      forkResponse.resolve(response);

      await expect(
        fixture.tool().execute("attach-fork", { action: "fork", thread_id: "source-thread" }),
      ).resolves.toMatchObject({ details: { attached: true } });

      expect(bindingStore.read(identity)).toMatchObject({
        threadId: "forked-thread",
        clientId: harness.client.getInstanceId(),
      });
      expect(hasCodexAppServerLiveThread(harness.client, "forked-thread")).toBe(true);
      expect(isCodexAppServerLiveThreadClaimed(harness.client, binding.threadId)).toBe(true);
      expect(unsubscribed).toEqual([]);
      await running!.release(binding.threadId);
      expect(unsubscribed).toEqual([binding.threadId]);
      expect(hasCodexAppServerLiveThread(harness.client, "forked-thread")).toBe(true);
    }));

  it.each(["binding", "model lock", "invocation owner"] as const)(
    "preserves %s changes while the native fork is in flight",
    (change) =>
      withFork(async (fixture) => {
        const operation = fixture.tool().execute("stale-fork", {
          action: "fork",
          thread_id: "source-thread",
        });
        const rejected = expect(operation).rejects.toThrow("native thread ownership changed");
        await fixture.forkWritten.promise;
        if (change === "binding") {
          await fixture.bindingStore.mutate(fixture.identity, {
            kind: "set",
            binding: { ...fixture.binding, threadId: "replacement-thread" },
          });
        } else if (change === "model lock") {
          fixture.session.modelSelectionLocked = true;
        } else {
          fixture.revokeInvocation();
        }
        fixture.forkResponse.resolve(fixture.response);
        await rejected;
        expect(fixture.bindingStore.read(fixture.identity)).toEqual(
          change === "binding"
            ? { ...fixture.binding, threadId: "replacement-thread" }
            : fixture.binding,
        );
        expect(fixture.unsubscribed).toEqual(["forked-thread"]);
        expect(hasCodexAppServerLiveThread(fixture.harness.client, "forked-thread")).toBe(false);
      }),
  );

  it("rejects a retained fork when its invocation ends during the binding write", () =>
    withFork(async (fixture) => {
      const mutate = fixture.bindingStore.mutate.bind(fixture.bindingStore);
      const bindingWrite = vi
        .spyOn(fixture.bindingStore, "mutate")
        .mockImplementationOnce((...args) => {
          expect(hasCodexAppServerLiveThread(fixture.harness.client, "forked-thread")).toBe(true);
          // The lazy facade awaits the binding owner before its guarded write.
          const pending = mutate(...args);
          fixture.revokeInvocation();
          return pending;
        });
      try {
        fixture.forkResponse.resolve(fixture.response);
        await expect(
          fixture.tool().execute("revoked-fork-write", {
            action: "fork",
            thread_id: "source-thread",
          }),
        ).rejects.toThrow("native thread ownership changed");

        expect(bindingWrite).toHaveBeenCalledOnce();
        expect(fixture.bindingStore.read(fixture.identity)).toEqual(fixture.binding);
        expect(fixture.unsubscribed).toEqual(["forked-thread"]);
        expect(hasCodexAppServerLiveThread(fixture.harness.client, "forked-thread")).toBe(false);
        expect(sharedClients.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
        await expect(
          fixture.harness.client.request("thread/read", { threadId: fixture.binding.threadId }),
        ).resolves.toMatchObject({ thread: { id: fixture.binding.threadId } });
      } finally {
        bindingWrite.mockRestore();
      }
    }));

  it.each(["successor binding", "model lock", "invocation owner"] as const)(
    "reports a committed fork after a later %s change",
    (change) =>
      withFork(async (fixture) => {
        const withLease = fixture.bindingStore.withLease.bind(fixture.bindingStore);
        const settledLease = vi
          .spyOn(fixture.bindingStore, "withLease")
          .mockImplementationOnce(
            async <T>(
              identity: CodexAppServerBindingIdentity,
              run: () => Promise<T>,
            ): Promise<T> => {
              const result = await withLease(identity, run);
              expect(fixture.bindingStore.read(identity)).toMatchObject({
                threadId: "forked-thread",
                clientId: fixture.harness.client.getInstanceId(),
              });
              if (change === "successor binding") {
                await expect(
                  fixture.bindingStore.mutate(identity, {
                    kind: "set",
                    binding: { ...fixture.binding, threadId: "successor-thread" },
                  }),
                ).resolves.toBe(true);
              } else if (change === "model lock") {
                fixture.session.modelSelectionLocked = true;
              } else {
                fixture.revokeInvocation();
              }
              return result;
            },
          );
        try {
          fixture.forkResponse.resolve(fixture.response);
          const outcome = await fixture
            .tool()
            .execute("committed-fork", {
              action: "fork",
              thread_id: "source-thread",
            })
            .then(
              (result) => ({ kind: "success", result }),
              (error: unknown) => ({ kind: "error", error }),
            );

          expect(settledLease).toHaveBeenCalledOnce();
          expect(fixture.bindingStore.read(fixture.identity)?.threadId).toBe(
            change === "successor binding" ? "successor-thread" : "forked-thread",
          );
          expect(fixture.session.modelSelectionLocked).toBe(change === "model lock");
          expect(hasCodexAppServerLiveThread(fixture.harness.client, "forked-thread")).toBe(true);
          expect(fixture.unsubscribed).toEqual([]);
          expect(outcome).toMatchObject({
            kind: "success",
            result: { details: { attached: true, thread: { id: "forked-thread" } } },
          });
        } finally {
          settledLease.mockRestore();
        }
      }),
  );

  it("unsubscribes a detached native fork without requiring an OpenClaw session", () =>
    withFork(async (fixture) => {
      fixture.forkResponse.resolve(fixture.response);
      await expect(
        fixture.tool(false).execute("detached-fork", {
          action: "fork",
          thread_id: "source-thread",
          attach: false,
        }),
      ).resolves.toMatchObject({ details: { attached: false } });
      expect(fixture.unsubscribed).toEqual(["forked-thread"]);
      expect(fixture.bindingStore.read(fixture.identity)).toEqual(fixture.binding);
      expect(hasCodexAppServerLiveThread(fixture.harness.client, "forked-thread")).toBe(false);
    }));

  it("retires the exact client when a written fork times out without a thread id", () =>
    withFork(async (fixture) => {
      const pending = fixture.tool(false, 100).execute("unknown-fork", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });
      const rejected = expect(pending).rejects.toThrow("timed out");
      await fixture.forkWritten.promise;
      await rejected;

      await expect(
        fixture.harness.client.request("thread/read", { threadId: "source-thread" }),
      ).rejects.toThrow("closed");
      expect(
        sharedClients.retireSharedCodexAppServerClientIfCurrent,
      ).toHaveBeenCalledExactlyOnceWith(fixture.harness.client);
      expect(fixture.unsubscribed).toEqual([]);
      expect(fixture.bindingStore.read(fixture.identity)).toEqual(fixture.binding);
    }));

  it("keeps the client available after native overload rejects the fork", () =>
    withFork(async (fixture) => {
      const pending = fixture.tool(false).execute("overloaded-fork", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });
      const rejected = expect(pending).rejects.toThrow("overloaded");
      await fixture.forkWritten.promise;
      fixture.forkResponse.reject({
        code: CODEX_APP_SERVER_OVERLOADED_ERROR_CODE,
        message: "overloaded",
      });
      await rejected;
      await expect(
        fixture.harness.client.request("thread/read", { threadId: "source-thread" }),
      ).resolves.toMatchObject({ thread: { id: "source-thread" } });
      expect(sharedClients.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
      expect(fixture.unsubscribed).toEqual([]);
    }));

  it.each([-32603, -32600])("retires a fork client after response assembly error %s", (code) =>
    withFork(async (fixture) => {
      const pending = fixture.tool(false).execute("failed-fork-response", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });
      const rejected = expect(pending).rejects.toThrow("failed to read the new fork");
      await fixture.forkWritten.promise;
      fixture.forkResponse.reject({ code, message: "failed to read the new fork" });
      await rejected;
      await expect(
        fixture.harness.client.request("thread/read", { threadId: "source-thread" }),
      ).rejects.toThrow("closed");
      expect(
        sharedClients.retireSharedCodexAppServerClientIfCurrent,
      ).toHaveBeenCalledExactlyOnceWith(fixture.harness.client);
      expect(fixture.unsubscribed).toEqual([]);
      expect(fixture.bindingStore.read(fixture.identity)).toEqual(fixture.binding);
    }),
  );

  it("keeps the client available when fork authority changes before dispatch", () =>
    withFork(async (fixture) => {
      sharedClients.getLeasedSharedCodexAppServerClient
        .mockResolvedValueOnce(fixture.harness.client)
        .mockImplementationOnce(async () => {
          fixture.session.modelSelectionLocked = true;
          return fixture.harness.client;
        });
      await expect(
        fixture.tool().execute("unwritten-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("native thread ownership changed");
      await expect(
        fixture.harness.client.request("thread/read", { threadId: "source-thread" }),
      ).resolves.toMatchObject({ thread: { id: "source-thread" } });
      expect(sharedClients.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
      expect(fixture.unsubscribed).toEqual([]);
    }));

  it.each([
    { response: {}, error: "invalid thread/fork response" },
    { response: { thread: {} }, error: "did not include a thread id" },
  ])("retires a fork subscription after $error", ({ response, error }) =>
    withFork(async (fixture) => {
      fixture.forkResponse.resolve(response);
      await expect(
        fixture.tool(false).execute("malformed-fork", {
          action: "fork",
          thread_id: "source-thread",
          attach: false,
        }),
      ).rejects.toThrow(error);
      await expect(
        fixture.harness.client.request("thread/read", { threadId: "source-thread" }),
      ).rejects.toThrow("closed");
      expect(
        sharedClients.retireSharedCodexAppServerClientIfCurrent,
      ).toHaveBeenCalledExactlyOnceWith(fixture.harness.client);
      expect(fixture.unsubscribed).toEqual([]);
      expect(fixture.bindingStore.read(fixture.identity)).toEqual(fixture.binding);
    }),
  );
});
