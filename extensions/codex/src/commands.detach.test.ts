import path from "node:path";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./app-server/client-runtime.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import type { CodexAppServerThreadBinding } from "./app-server/session-binding.js";
import { testCodexAppServerBindingStore } from "./app-server/session-binding.test-helpers.js";
import { createClientHarness } from "./app-server/test-support.js";
import { handleCodexCommand } from "./command-dispatch.js";
import {
  createContext,
  createDeps,
  createThreadResumeResponse,
  useCodexCommandTestState,
  writeTestBinding,
} from "./commands.test-support.js";
import { handleCodexConversationInboundClaim } from "./conversation-binding-hooks.js";

describe("codex detach command", () => {
  let tempDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
  });

  it("detaches the current conversation and clears the Codex app-server thread binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const ownershipOrder: string[] = [];
    const identity = { kind: "conversation" as const, bindingId: "binding-data-1" };
    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    const releaseNativeThread = vi
      .spyOn(harness.client, "request")
      .mockImplementation(async (method) => {
        if (method !== "thread/unsubscribe") {
          throw new Error(`unexpected Codex method ${method}`);
        }
        ownershipOrder.push("native-release");
        return {} as never;
      });
    await retainCodexAppServerLiveThread(harness.client, "thread-detached");
    const clearBinding = vi.fn(
      async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
        ownershipOrder.push("native-clear");
        return await testCodexAppServerBindingStore.mutate(...args);
      },
    );
    const detachConversationBinding = vi.fn(async () => {
      ownershipOrder.push("public");
      return { removed: true };
    });
    await writeTestBinding(identity, {
      threadId: "thread-detached",
      clientId: harness.client.getInstanceId(),
      cwd: "/repo",
    });
    const sharedClientRuntime = await import("./app-server/shared-client.js");
    const retainClient = vi
      .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
      .mockResolvedValue({ client: harness.client, release: vi.fn() });

    try {
      await expect(
        handleCodexCommand(
          createContext("detach", sessionFile, {
            detachConversationBinding,
            getCurrentConversationBinding: async () => ({
              bindingId: "binding-1",
              pluginId: "codex",
              pluginRoot: "/plugin",
              channel: "test",
              accountId: "default",
              conversationId: "conversation",
              boundAt: 1,
              data: {
                kind: "codex-app-server-session",
                version: 2,
                bindingId: "binding-data-1",
                workspaceDir: "/repo",
              },
            }),
          }),
          {
            deps: createDeps({
              bindingStore: { ...testCodexAppServerBindingStore, mutate: clearBinding },
            }),
          },
        ),
      ).resolves.toEqual({
        text: "Detached this conversation from Codex.",
      });
      expect(detachConversationBinding).toHaveBeenCalled();
      expect(clearBinding).toHaveBeenCalledWith(
        identity,
        { kind: "clear", threadId: "thread-detached" },
        expect.any(Function),
      );
      expect(releaseNativeThread).toHaveBeenCalledWith(
        "thread/unsubscribe",
        { threadId: "thread-detached" },
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
      expect(ownershipOrder).toEqual(["native-release", "native-clear", "public"]);
    } finally {
      retainClient.mockRestore();
      harness.client.close();
    }
  });

  it.each(["queued clear", "queued restore", "public detach"] as const)(
    "rejects conversation detachment when owner authority is revoked before %s",
    async (phase) => {
      const identity = { kind: "conversation" as const, bindingId: "binding-revoked-detach" };
      const originalBinding = {
        threadId: "thread-revoked-detach",
        cwd: tempDir,
        conversationStartId: "start-revoked-detach",
        historyCoveredThrough: "2026-01-01T00:00:00.000Z",
      } satisfies CodexAppServerThreadBinding;
      await writeTestBinding(identity, originalBinding);
      const originalStoredBinding = testCodexAppServerBindingStore.read(identity);
      expect(originalStoredBinding).toMatchObject(originalBinding);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let ownerCurrent = true;
      const mutate = async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
        const gated = args[1].kind === (phase === "queued restore" ? "set" : "clear");
        if (gated && phase !== "public detach") {
          entered.resolve();
          await release.promise;
        }
        // Preserve the real lifecycle's authority checks and stored mutation.
        const applied = await testCodexAppServerBindingStore.mutate(...args);
        if (gated && phase === "public detach") {
          entered.resolve();
          await release.promise;
        }
        return applied;
      };
      const detachConversationBinding = vi.fn(async () => {
        if (phase === "queued restore") {
          throw new Error("public conversation binding store write failed");
        }
        return { removed: true };
      });
      const command = handleCodexCommand(
        createContext("detach", undefined, {
          assertOwnerCurrent: () => {
            if (!ownerCurrent) {
              throw new Error("Command owner was revoked");
            }
          },
          detachConversationBinding,
          getCurrentConversationBinding: async () => ({
            bindingId: "binding-public-revoked-detach",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "test",
            accountId: "default",
            conversationId: "conversation",
            boundAt: 1,
            data: {
              kind: "codex-app-server-session",
              version: 2,
              bindingId: identity.bindingId,
              workspaceDir: tempDir,
              start: { id: originalBinding.conversationStartId },
            },
          }),
        }),
        {
          deps: createDeps({
            bindingStore: { ...testCodexAppServerBindingStore, mutate },
          }),
        },
      );
      try {
        expect(
          await Promise.race([
            entered.promise.then(() => "entered"),
            command.then(() => "settled"),
          ]),
        ).toBe("entered");
        const expectedBinding = phase === "queued clear" ? originalStoredBinding : undefined;
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(expectedBinding);
        ownerCurrent = false;
        release.resolve();

        const result = await command;
        expect(result.text).toContain(
          phase === "queued clear" ? "Command owner was revoked" : "could not be restored",
        );
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(expectedBinding);
        expect(detachConversationBinding).toHaveBeenCalledTimes(phase === "queued restore" ? 1 : 0);
      } finally {
        release.resolve();
        await command;
      }
    },
  );

  it.each([
    {
      label: "an incognito source bound into an ordinary destination",
      sourceSessionKey: "agent:main:dashboard:incognito-source",
      destinationSessionKey: "agent:main:discord:ordinary-destination",
      unsubscribes: true,
    },
    {
      label: "an ordinary source bound into an incognito destination",
      sourceSessionKey: "agent:main:discord:ordinary-source",
      destinationSessionKey: "agent:main:dashboard:incognito-destination",
      unsubscribes: false,
    },
    {
      label: "a missing source bound into an incognito destination",
      sourceSessionKey: undefined,
      destinationSessionKey: "agent:main:dashboard:incognito-destination",
      unsubscribes: false,
    },
  ])(
    "retires untracked detach ownership from $label using its source session",
    async ({ sourceSessionKey, destinationSessionKey, unsubscribes }) => {
      const identity = { kind: "conversation" as const, bindingId: "binding-mixed-session" };
      await writeTestBinding(identity, {
        threadId: "thread-mixed-session",
        clientId: "client-mixed-session",
        cwd: "/repo",
      });
      const request = vi.fn(async () => ({}));
      const releaseClient = vi.fn();
      const sharedClientRuntime = await import("./app-server/shared-client.js");
      const retainClient = vi
        .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
        .mockResolvedValue({
          client: { request } as unknown as CodexAppServerClient,
          release: releaseClient,
        });
      const detachConversationBinding = vi.fn(async () => ({ removed: true }));

      try {
        await expect(
          handleCodexCommand(
            createContext("detach", undefined, {
              sessionKey: destinationSessionKey,
              detachConversationBinding,
              getCurrentConversationBinding: async () => ({
                bindingId: "binding-public",
                pluginId: "codex",
                pluginRoot: "/plugin",
                channel: "test",
                accountId: "default",
                conversationId: "conversation",
                boundAt: 1,
                data: {
                  kind: "codex-app-server-session",
                  version: 2,
                  bindingId: identity.bindingId,
                  workspaceDir: "/repo",
                  ...(sourceSessionKey
                    ? {
                        source: {
                          agentId: "main",
                          sessionId: "session-source",
                          sessionKey: sourceSessionKey,
                          threadId: "thread-source",
                        },
                      }
                    : {}),
                },
              }),
            }),
            { deps: createDeps() },
          ),
        ).resolves.toEqual({ text: "Detached this conversation from Codex." });

        if (unsubscribes) {
          expect(request).toHaveBeenCalledExactlyOnceWith(
            "thread/unsubscribe",
            { threadId: "thread-mixed-session" },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
          );
        } else {
          expect(request).not.toHaveBeenCalled();
        }
        expect(releaseClient).toHaveBeenCalledOnce();
        expect(detachConversationBinding).toHaveBeenCalledOnce();
        expect(testCodexAppServerBindingStore.read(identity)).toBeUndefined();
      } finally {
        retainClient.mockRestore();
      }
    },
  );

  it("preserves the public conversation binding when native retirement fails", async () => {
    const identity = { kind: "conversation" as const, bindingId: "binding-data-1" };
    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    await writeTestBinding(identity, {
      threadId: "thread-detached",
      clientId: harness.client.getInstanceId(),
      cwd: "/repo",
    });
    const detachConversationBinding = vi.fn(async () => ({ removed: true }));
    const releaseNativeThread = vi
      .spyOn(harness.client, "request")
      .mockImplementation(async (method) => {
        if (method !== "thread/unsubscribe") {
          throw new Error(`unexpected Codex method ${method}`);
        }
        throw new Error("Codex native thread subscription could not be released");
      });
    await retainCodexAppServerLiveThread(harness.client, "thread-detached");
    const sharedClientRuntime = await import("./app-server/shared-client.js");
    const retainClient = vi
      .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
      .mockResolvedValue({ client: harness.client, release: vi.fn() });

    try {
      const result = await handleCodexCommand(
        createContext("detach", undefined, {
          detachConversationBinding,
          getCurrentConversationBinding: async () => ({
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: "/plugin",
            channel: "test",
            accountId: "default",
            conversationId: "conversation",
            boundAt: 1,
            data: {
              kind: "codex-app-server-session",
              version: 2,
              bindingId: identity.bindingId,
              workspaceDir: "/repo",
            },
          }),
        }),
        { deps: createDeps() },
      );

      expect(result.text).toContain("native thread subscription could not be released");
      expect(releaseNativeThread).toHaveBeenCalledOnce();
      expect(detachConversationBinding).not.toHaveBeenCalled();
      expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
        threadId: "thread-detached",
        clientId: harness.client.getInstanceId(),
        cwd: "/repo",
      });
      await expect(
        consumeCodexAppServerLiveThread(harness.client, "thread-detached"),
      ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
    } finally {
      retainClient.mockRestore();
      harness.client.close();
    }
  });

  it.each([
    {
      label: "returns false",
      throws: false,
      message: "changed while detaching",
    },
    {
      label: "throws",
      throws: true,
      message: "native durable binding clear failed",
    },
  ])(
    "preserves the public conversation when durable native clear $label",
    async ({ throws, message }) => {
      const identity = { kind: "conversation" as const, bindingId: "binding-clear-failure" };
      const harness = createClientHarness();
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
      const releaseNativeThread = vi
        .spyOn(harness.client, "request")
        .mockResolvedValue({} as never);
      await retainCodexAppServerLiveThread(harness.client, "thread-clear-failure");
      const originalBinding = {
        threadId: "thread-clear-failure",
        clientId: harness.client.getInstanceId(),
        cwd: tempDir,
        conversationStartId: "start-clear-failure",
      } satisfies CodexAppServerThreadBinding;
      await writeTestBinding(identity, originalBinding);
      const mutate = vi.fn(
        async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
          if (args[1].kind === "clear") {
            if (throws) {
              throw new Error("native durable binding clear failed");
            }
            return false;
          }
          return await testCodexAppServerBindingStore.mutate(...args);
        },
      );
      const detachConversationBinding = vi.fn(async () => ({ removed: true }));
      const sharedClientRuntime = await import("./app-server/shared-client.js");
      const retainClient = vi
        .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
        .mockResolvedValue({ client: harness.client, release: vi.fn() });

      try {
        const result = await handleCodexCommand(
          createContext("detach", undefined, {
            detachConversationBinding,
            getCurrentConversationBinding: async () => ({
              bindingId: "binding-public-clear-failure",
              pluginId: "codex",
              pluginRoot: tempDir,
              channel: "test",
              accountId: "default",
              conversationId: "conversation",
              boundAt: 1,
              data: {
                kind: "codex-app-server-session",
                version: 2,
                bindingId: identity.bindingId,
                workspaceDir: tempDir,
                start: { id: originalBinding.conversationStartId },
              },
            }),
          }),
          {
            deps: createDeps({
              bindingStore: { ...testCodexAppServerBindingStore, mutate },
            }),
          },
        );

        expect(result.text).toContain(message);
        expect(releaseNativeThread).toHaveBeenCalledOnce();
        expect(mutate).toHaveBeenCalledOnce();
        expect(detachConversationBinding).not.toHaveBeenCalled();
        expect(testCodexAppServerBindingStore.read(identity)).toMatchObject(originalBinding);
      } finally {
        retainClient.mockRestore();
        harness.client.close();
      }
    },
  );

  it("resumes the original native thread after public conversation detachment fails", async () => {
    const identity = { kind: "conversation" as const, bindingId: "binding-detach-recovery" };
    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    const operations: string[] = [];
    const request = vi
      .spyOn(harness.client, "request")
      .mockImplementation(async (method, params) => {
        operations.push(method);
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] } as never;
        }
        if (method === "thread/unsubscribe") {
          return {} as never;
        }
        if (method === "thread/read") {
          return {
            thread: createThreadResumeResponse({
              threadId: "thread-original-context",
              cwd: tempDir,
            }).thread,
          } as never;
        }
        if (method === "thread/resume") {
          return createThreadResumeResponse({
            threadId: "thread-original-context",
            cwd: tempDir,
          }) as never;
        }
        if (method === "turn/start") {
          queueMicrotask(() => {
            harness.send({
              method: "turn/completed",
              params: {
                threadId: "thread-original-context",
                turn: {
                  id: "turn-original-context",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "answer", text: "Original context kept" }],
                },
              },
            });
          });
          return { turn: { id: "turn-original-context" } } as never;
        }
        throw new Error(`unexpected Codex method ${method}: ${JSON.stringify(params)}`);
      });
    await retainCodexAppServerLiveThread(harness.client, "thread-original-context");
    const originalBinding = {
      threadId: "thread-original-context",
      clientId: harness.client.getInstanceId(),
      cwd: tempDir,
      conversationStartId: "start-original-context",
      historyCoveredThrough: "2026-01-01T00:00:00.000Z",
    } satisfies CodexAppServerThreadBinding;
    await writeTestBinding(identity, originalBinding);
    const publicBinding = {
      bindingId: "binding-public-original-context",
      pluginId: "codex",
      pluginRoot: tempDir,
      channel: "test",
      accountId: "default",
      conversationId: "conversation",
      boundAt: 1,
      data: {
        kind: "codex-app-server-session" as const,
        version: 2 as const,
        bindingId: identity.bindingId,
        workspaceDir: tempDir,
        start: { id: originalBinding.conversationStartId },
      },
    };
    const detachConversationBinding = vi.fn(async () => {
      throw new Error("public conversation binding store write failed");
    });
    const mutate = vi.fn(
      async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) =>
        await testCodexAppServerBindingStore.mutate(...args),
    );
    const sharedClientRuntime = await import("./app-server/shared-client.js");
    const retainClient = vi
      .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
      .mockResolvedValue({ client: harness.client, release: vi.fn() });
    const acquireClient = vi
      .spyOn(sharedClientRuntime, "getLeasedSharedCodexAppServerClient")
      .mockResolvedValue(harness.client);
    const resolvePublic = vi
      .spyOn(getSessionBindingService(), "resolveByConversation")
      .mockReturnValue({ bindingId: publicBinding.bindingId } as never);

    try {
      const result = await handleCodexCommand(
        createContext("detach", undefined, {
          detachConversationBinding,
          getCurrentConversationBinding: async () => publicBinding,
        }),
        {
          deps: createDeps({
            bindingStore: { ...testCodexAppServerBindingStore, mutate },
          }),
        },
      );

      expect(result.text).toContain("public conversation binding store write failed");
      expect(operations).toEqual(["thread/unsubscribe"]);
      expect(mutate.mock.calls.map(([, mutation]) => mutation.kind)).toEqual(["clear", "set"]);
      expect(mutate).toHaveBeenLastCalledWith(
        identity,
        { kind: "set", binding: originalBinding, if: { kind: "absent" } },
        expect.any(Function),
      );
      expect(testCodexAppServerBindingStore.read(identity)).toMatchObject(originalBinding);

      await expect(
        handleCodexConversationInboundClaim(
          {
            content: "continue original task",
            bodyForAgent: "continue original task",
            channel: "test",
            isGroup: false,
            commandAuthorized: true,
            senderIsOwner: true,
          },
          { channelId: "test", pluginBinding: publicBinding },
          { bindingStore: testCodexAppServerBindingStore, timeoutMs: 500 },
        ),
      ).resolves.toEqual({
        handled: true,
        reply: { text: "Original context kept" },
      });
      expect(operations).toEqual([
        "thread/unsubscribe",
        "thread/read",
        "config/read",
        "thread/resume",
        "turn/start",
      ]);
      expect(request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toMatchObject({
        threadId: originalBinding.threadId,
      });
      expect(request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toMatchObject({
        threadId: originalBinding.threadId,
        cwd: originalBinding.cwd,
      });
      expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
        threadId: originalBinding.threadId,
        conversationStartId: originalBinding.conversationStartId,
        historyCoveredThrough: originalBinding.historyCoveredThrough,
      });
    } finally {
      resolvePublic.mockRestore();
      acquireClient.mockRestore();
      retainClient.mockRestore();
      harness.client.close();
    }
  });

  it.each([
    { label: "returns false", throws: false },
    { label: "throws", throws: true },
  ])("shows actionable thread recovery when public detach rollback $label", async ({ throws }) => {
    const identity = { kind: "conversation" as const, bindingId: "binding-rollback-failure" };
    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    const releaseNativeThread = vi.spyOn(harness.client, "request").mockResolvedValue({} as never);
    await retainCodexAppServerLiveThread(harness.client, "thread-rollback-failure");
    await writeTestBinding(identity, {
      threadId: "thread-rollback-failure",
      clientId: harness.client.getInstanceId(),
      cwd: tempDir,
    });
    const mutate = vi.fn(
      async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
        if (args[1].kind === "set") {
          if (throws) {
            throw new Error("native durable binding restore failed");
          }
          return false;
        }
        return await testCodexAppServerBindingStore.mutate(...args);
      },
    );
    const detachConversationBinding = vi.fn(async () => {
      throw new Error("public conversation binding store write failed");
    });
    const sharedClientRuntime = await import("./app-server/shared-client.js");
    const retainClient = vi
      .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
      .mockResolvedValue({ client: harness.client, release: vi.fn() });

    try {
      const result = await handleCodexCommand(
        createContext("detach", undefined, {
          detachConversationBinding,
          getCurrentConversationBinding: async () => ({
            bindingId: "binding-public-rollback-failure",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "test",
            accountId: "default",
            conversationId: "conversation",
            boundAt: 1,
            data: {
              kind: "codex-app-server-session",
              version: 2,
              bindingId: identity.bindingId,
              workspaceDir: tempDir,
            },
          }),
        }),
        {
          deps: createDeps({
            bindingStore: { ...testCodexAppServerBindingStore, mutate },
          }),
        },
      );

      expect(result.text).toContain("native thread thread-rollback-failure could not be restored");
      expect(result.text).toContain("/codex resume thread-rollback-failure");
      expect(releaseNativeThread).toHaveBeenCalledOnce();
      expect(detachConversationBinding).toHaveBeenCalledOnce();
      expect(mutate.mock.calls.map(([, mutation]) => mutation.kind)).toEqual(["clear", "set"]);
      expect(testCodexAppServerBindingStore.read(identity)).toBeUndefined();
    } finally {
      retainClient.mockRestore();
      harness.client.close();
    }
  });

  it("rejects malformed detach commands before clearing bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const clearBinding = vi.fn();
    const detachConversationBinding = vi.fn();

    await expect(
      handleCodexCommand(
        createContext("detach now", sessionFile, {
          detachConversationBinding,
        }),
        {
          deps: createDeps({
            bindingStore: { ...testCodexAppServerBindingStore, mutate: clearBinding },
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex detach",
    });
    expect(detachConversationBinding).not.toHaveBeenCalled();
    expect(clearBinding).not.toHaveBeenCalled();
  });
});
