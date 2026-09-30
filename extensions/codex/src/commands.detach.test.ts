import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./app-server/client-runtime.js";
import type { CodexAppServerThreadBinding } from "./app-server/session-binding.js";
import { testCodexAppServerBindingStore as bindingStore } from "./app-server/session-binding.test-helpers.js";
import * as sharedClientRuntime from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  createThreadResumeResponse,
  runCommand,
  useCodexCommandTestState,
  writeTestBinding,
} from "./commands.test-support.js";
import { handleCodexConversationInboundClaim } from "./conversation-binding-hooks.js";

describe("codex detach command", () => {
  let tempDir: string;
  const cleanup: Array<() => void> = [];
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
    beforeCleanup: () => {
      for (const close of cleanup.splice(0).toReversed()) {
        close();
      }
    },
  });

  async function fixture(binding: Partial<CodexAppServerThreadBinding> = {}) {
    const identity = { kind: "conversation" as const, bindingId: "binding-detach" };
    const original = { threadId: "thread-detached", cwd: "/repo", ...binding };
    await writeTestBinding(identity, original);
    const conversation = {
      bindingId: "binding-public",
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
        workspaceDir: original.cwd,
        ...(original.conversationStartId ? { start: { id: original.conversationStartId } } : {}),
      },
    };
    const mutate = vi.fn(
      async (...args: Parameters<typeof bindingStore.mutate>) => await bindingStore.mutate(...args),
    );
    const detach = vi.fn(async () => ({ removed: true }));
    return {
      identity,
      original,
      conversation,
      mutate,
      detach,
      read: () => bindingStore.read(identity),
      run: (context: Partial<PluginCommandContext> = {}) =>
        runCommand(
          "detach",
          { bindingStore: { ...bindingStore, mutate } },
          {
            detachConversationBinding: detach,
            getCurrentConversationBinding: async () => conversation,
            ...context,
          },
        ),
    };
  }

  async function nativeFixture(binding: Partial<CodexAppServerThreadBinding> = {}, tracked = true) {
    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
      if (method !== "thread/unsubscribe") {
        throw new Error(`unexpected Codex method ${method}`);
      }
      return {} as never;
    });
    const releaseClient = vi.fn();
    const retainClient = vi
      .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
      .mockResolvedValue({ client: harness.client, release: releaseClient });
    cleanup.push(() => {
      retainClient.mockRestore();
      harness.client.close();
    });
    const f = await fixture({ clientId: harness.client.getInstanceId(), ...binding });
    if (tracked) {
      await retainCodexAppServerLiveThread(harness.client, f.original.threadId);
    }
    return { ...f, harness, request, releaseClient };
  }

  it("detaches the current conversation and clears the Codex app-server thread binding", async () => {
    const f = await nativeFixture();
    const order: string[] = [];
    f.request.mockImplementation(async (method) => {
      if (method !== "thread/unsubscribe") {
        throw new Error(`unexpected Codex method ${method}`);
      }
      order.push("native-release");
      return {} as never;
    });
    f.mutate.mockImplementation(async (...args) => {
      order.push("native-clear");
      return await bindingStore.mutate(...args);
    });
    f.detach.mockImplementation(async () => {
      order.push("public");
      return { removed: true };
    });

    await expect(f.run()).resolves.toEqual({ text: "Detached this conversation from Codex." });
    expect(f.detach).toHaveBeenCalled();
    expect(f.mutate).toHaveBeenCalledWith(
      f.identity,
      { kind: "clear", threadId: f.original.threadId },
      expect.any(Function),
    );
    expect(f.request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: f.original.threadId },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(order).toEqual(["native-release", "native-clear", "public"]);
  });

  it.each(["queued clear", "queued restore", "public detach"] as const)(
    "rejects conversation detachment when owner authority is revoked before %s",
    async (phase) => {
      const f = await fixture({
        cwd: tempDir,
        conversationStartId: "start-revoked-detach",
        historyCoveredThrough: "2026-01-01T00:00:00.000Z",
      });
      const originalStored = f.read();
      expect(originalStored).toMatchObject(f.original);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let ownerCurrent = true;
      f.mutate.mockImplementation(async (...args) => {
        const gated = args[1].kind === (phase === "queued restore" ? "set" : "clear");
        if (gated && phase !== "public detach") {
          entered.resolve();
          await release.promise;
        }
        const applied = await bindingStore.mutate(...args);
        if (gated && phase === "public detach") {
          entered.resolve();
          await release.promise;
        }
        return applied;
      });
      f.detach.mockImplementation(async () => {
        if (phase === "queued restore") {
          throw new Error("public conversation binding store write failed");
        }
        return { removed: true };
      });
      const command = f.run({
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      });
      try {
        expect(
          await Promise.race([
            entered.promise.then(() => "entered"),
            command.then(() => "settled"),
          ]),
        ).toBe("entered");
        const expected = phase === "queued clear" ? originalStored : undefined;
        expect(f.read()).toEqual(expected);
        ownerCurrent = false;
        release.resolve();
        expect((await command).text).toContain(
          phase === "queued clear" ? "Command owner was revoked" : "could not be restored",
        );
        expect(f.read()).toEqual(expected);
        expect(f.detach).toHaveBeenCalledTimes(phase === "queued restore" ? 1 : 0);
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
  ])(
    "retires untracked detach ownership from $label using its source session",
    async ({ sourceSessionKey, destinationSessionKey, unsubscribes }) => {
      const f = await nativeFixture({}, false);
      await expect(
        f.run({
          sessionKey: destinationSessionKey,
          getCurrentConversationBinding: async () => ({
            ...f.conversation,
            data: {
              ...f.conversation.data,
              source: {
                agentId: "main",
                sessionId: "session-source",
                sessionKey: sourceSessionKey,
                threadId: "thread-source",
              },
            },
          }),
        }),
      ).resolves.toEqual({ text: "Detached this conversation from Codex." });
      if (unsubscribes) {
        expect(f.request).toHaveBeenCalledExactlyOnceWith(
          "thread/unsubscribe",
          { threadId: f.original.threadId },
          expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
      } else {
        expect(f.request).not.toHaveBeenCalled();
      }
      expect(f.releaseClient).toHaveBeenCalledOnce();
      expect(f.detach).toHaveBeenCalledOnce();
      expect(f.read()).toBeUndefined();
    },
  );

  it("preserves the public conversation binding when native retirement fails", async () => {
    const f = await nativeFixture();
    f.request.mockImplementation(async (method) => {
      if (method !== "thread/unsubscribe") {
        throw new Error(`unexpected Codex method ${method}`);
      }
      throw new Error("Codex native thread subscription could not be released");
    });
    expect((await f.run()).text).toContain("native thread subscription could not be released");
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.read()).toMatchObject(f.original);
    await expect(
      consumeCodexAppServerLiveThread(f.harness.client, f.original.threadId),
    ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
  });

  it("preserves the public conversation when durable native clear returns false", async () => {
    const f = await nativeFixture({ cwd: tempDir, conversationStartId: "start-clear-failure" });
    f.mutate.mockImplementation(async (...args) =>
      args[1].kind === "clear" ? false : await bindingStore.mutate(...args),
    );
    expect((await f.run()).text).toContain("changed while detaching");
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.mutate).toHaveBeenCalledOnce();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.read()).toMatchObject(f.original);
  });

  it("resumes the original native thread after public conversation detachment fails", async () => {
    const f = await nativeFixture({
      cwd: tempDir,
      conversationStartId: "start-original-context",
      historyCoveredThrough: "2026-01-01T00:00:00.000Z",
    });
    const { threadId, cwd } = f.original;
    f.request.mockImplementation(async (method, params) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] } as never;
      }
      if (method === "thread/unsubscribe") {
        return {} as never;
      }
      if (method === "thread/read") {
        return { thread: createThreadResumeResponse({ threadId, cwd }).thread } as never;
      }
      if (method === "thread/resume") {
        return createThreadResumeResponse({ threadId, cwd }) as never;
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          f.harness.send({
            method: "turn/completed",
            params: {
              threadId,
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
    f.detach.mockRejectedValue(new Error("public conversation binding store write failed"));
    const acquireClient = vi
      .spyOn(sharedClientRuntime, "getLeasedSharedCodexAppServerClient")
      .mockResolvedValue(f.harness.client);
    const resolvePublic = vi
      .spyOn(getSessionBindingService(), "resolveByConversation")
      .mockReturnValue({ bindingId: f.conversation.bindingId } as never);
    cleanup.push(() => {
      resolvePublic.mockRestore();
      acquireClient.mockRestore();
    });

    expect((await f.run()).text).toContain("public conversation binding store write failed");
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/unsubscribe"]);
    expect(f.mutate.mock.calls.map(([, mutation]) => mutation.kind)).toEqual(["clear", "set"]);
    expect(f.mutate).toHaveBeenLastCalledWith(
      f.identity,
      { kind: "set", binding: f.original, if: { kind: "absent" } },
      expect.any(Function),
    );
    expect(f.read()).toMatchObject(f.original);
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
        { channelId: "test", pluginBinding: f.conversation },
        { bindingStore, timeoutMs: 500 },
      ),
    ).resolves.toEqual({ handled: true, reply: { text: "Original context kept" } });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/unsubscribe",
      "thread/read",
      "config/read",
      "thread/resume",
      "turn/start",
    ]);
    expect(f.request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toMatchObject({
      threadId,
    });
    expect(f.request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toMatchObject({
      threadId,
      cwd,
    });
    expect(f.read()).toMatchObject({
      threadId,
      conversationStartId: f.original.conversationStartId,
      historyCoveredThrough: f.original.historyCoveredThrough,
    });
  });

  it("shows actionable thread recovery when public detach rollback returns false", async () => {
    const f = await nativeFixture({ cwd: tempDir });
    f.mutate.mockImplementation(async (...args) =>
      args[1].kind === "set" ? false : await bindingStore.mutate(...args),
    );
    f.detach.mockRejectedValue(new Error("public conversation binding store write failed"));
    const result = await f.run();
    expect(result.text).toContain(`native thread ${f.original.threadId} could not be restored`);
    expect(result.text).toContain(`/codex resume ${f.original.threadId}`);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.detach).toHaveBeenCalledOnce();
    expect(f.mutate.mock.calls.map(([, mutation]) => mutation.kind)).toEqual(["clear", "set"]);
    expect(f.read()).toBeUndefined();
  });
});
