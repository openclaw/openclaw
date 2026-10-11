import path from "node:path";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./app-server/client-runtime.js";
import type { CodexAppServerThreadBinding } from "./app-server/session-binding.js";
import { testCodexAppServerBindingStore } from "./app-server/session-binding.test-helpers.js";
import * as detachSharedClientRuntime from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { handleCodexCommand } from "./command-dispatch.js";
import type { CodexControlRequestOptions } from "./command-rpc.js";
import {
  createCodexRuntimeContextOverrides,
  runCommand,
  writeTestBinding,
  useCodexCommandTestState,
  createThreadResumeResponse,
  createContext,
  createDeps,
  expectedDiagnosticsTargetBlock,
  readDiagnosticsConfirmationToken,
  supervisedTestBinding,
  requireResultText,
} from "./commands.test-support.js";
import { handleCodexConversationInboundClaim } from "./conversation-binding-hooks.js";
import {
  steerCodexConversationTurn as steerCodexConversationTurnImpl,
  stopCodexConversationTurn as stopCodexConversationTurnImpl,
  trackCodexConversationActiveTurn,
} from "./conversation-control.js";

const requireRecord = createRequireRecord("object", "expected-label");

describe("Codex command authority", () => {
  let authorityStateDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      authorityStateDir = stateDir;
    },
  });

  async function boundRuntime(sessionKey: string, model?: string) {
    const runtime = await createCodexRuntimeContextOverrides(authorityStateDir, sessionKey);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: runtime.sessionKey,
    };
    await writeTestBinding(identity, { threadId: "thread-control", cwd: "/repo", model });
    return { runtime, identity };
  }

  it.each([
    { command: "stop", revokeOwner: false },
    { command: "steer", revokeOwner: true },
  ] as const)(
    "rejects queued $command before any write after authority changes (owner: $revokeOwner)",
    async ({ command, revokeOwner }) => {
      const { runtime, identity } = await boundRuntime(`agent:main:test:queued-${command}`);
      let ownerCurrent = true;
      const context = {
        ...runtime,
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      };
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const request = requireRecord(JSON.parse(line), "Codex request");
          send({ id: request.id, result: {} });
        },
      });
      const stopTracking = trackCodexConversationActiveTurn({
        identity,
        client: harness.client,
        requestTimeoutMs: 60_000,
        threadId: "thread-control",
        turnId: "turn-1",
      });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const queued =
        <P, R>(operation: (params: P) => Promise<R>) =>
        async (params: P) => {
          entered.resolve();
          await release.promise;
          return await operation(params);
        };

      try {
        const pending = runCommand(
          command === "stop" ? "stop" : "steer keep the authority boundary",
          {
            stopCodexConversationTurn: queued(stopCodexConversationTurnImpl),
            steerCodexConversationTurn: queued(steerCodexConversationTurnImpl),
          },
          context,
        );
        await entered.promise;
        if (revokeOwner) {
          ownerCurrent = false;
        } else {
          await upsertSessionEntry({
            storePath: runtime.sessionTarget.storePath,
            sessionKey: runtime.sessionKey,
            entry: {
              sessionId: "session-next",
              previousSessionId: "session-1",
              updatedAt: Date.now(),
              agentHarnessId: "codex",
            },
          });
        }
        release.resolve();

        expect((await pending).text).toContain(
          revokeOwner
            ? "Command owner was revoked"
            : "Codex session generation is no longer current",
        );
        expect(harness.writes).toHaveLength(0);
      } finally {
        release.resolve();
        stopTracking();
        harness.client.close();
      }
    },
  );

  it("does not require owner authority for current-session control status reads", async () => {
    const { runtime } = await boundRuntime("agent:main:test:read-only-controls", "gpt-5.5");
    const context = {
      ...runtime,
      senderIsOwner: false,
      assertOwnerCurrent: () => {
        throw new Error("Caller is not a channel owner");
      },
    };
    const codexControlRequest = vi.fn(
      async (
        _pluginConfig: unknown,
        _method: string,
        _params: unknown,
        options?: CodexControlRequestOptions,
      ) => {
        options?.assertCurrent?.();
        options?.assertOwnerCurrent?.();
        return { goal: null };
      },
    );
    for (const [command, expected] of [
      ["model", "Codex model: gpt-5.5"],
      ["fast status", "Codex fast mode: off."],
      ["permissions status", "Codex permissions: default."],
      ["goal status", "No Codex goal is active."],
    ] as const) {
      const result = await runCommand(command, { codexControlRequest }, context);
      expect(result.text).toBe(expected);
    }
    expect(codexControlRequest).toHaveBeenCalledOnce();
  });
});

describe("codex detach command", () => {
  const bindingStore = testCodexAppServerBindingStore;
  let detachStateDir: string;
  const cleanup: Array<() => void> = [];
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      detachStateDir = stateDir;
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
      pluginRoot: detachStateDir,
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
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: detachStateDir });
    const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
      if (method !== "thread/unsubscribe") {
        throw new Error(`unexpected Codex method ${method}`);
      }
      return {} as never;
    });
    const releaseClient = vi.fn();
    const retainClient = vi
      .spyOn(detachSharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
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
        cwd: detachStateDir,
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
    const f = await nativeFixture({
      cwd: detachStateDir,
      conversationStartId: "start-clear-failure",
    });
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
      cwd: detachStateDir,
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
      .spyOn(detachSharedClientRuntime, "getLeasedSharedCodexAppServerClient")
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
    const f = await nativeFixture({ cwd: detachStateDir });
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

describe("Codex diagnostics confirmation", () => {
  const bindingStore = testCodexAppServerBindingStore;
  let diagnosticsStateDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      diagnosticsStateDir = stateDir;
    },
  });

  async function fixture(
    binding: CodexAppServerThreadBinding = { threadId: "thread-diagnostics", cwd: "/repo" },
    context: Partial<PluginCommandContext> = {},
    pluginConfig?: unknown,
  ) {
    const identity = {
      kind: "session" as const,
      agentId: context.agentId ?? "main",
      sessionId: context.sessionId ?? "session-1",
      sessionKey: context.sessionKey,
    };
    await writeTestBinding(identity, binding);
    const upload = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: binding.threadId },
    }));
    const deps = createDeps({ safeCodexControlRequest: upload });
    const run = (args: string, overrides: Partial<PluginCommandContext> = {}) =>
      handleCodexCommand(createContext(args, undefined, { ...context, ...overrides }), {
        deps,
        pluginConfig,
      });
    return { identity, upload, deps, run };
  }

  it("preserves an accepted upload and blocks the next target after owner revocation", async () => {
    let ownerCurrent = true;
    const f = await fixture(
      { threadId: "thread-session-1", cwd: "/repo" },
      {
        diagnosticsUploadApproved: true,
        diagnosticsSessions: [{ sessionId: "session-2", channel: "test" }],
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      },
    );
    await writeTestBinding(
      { ...f.identity, sessionId: "session-2" },
      { threadId: "thread-session-2", cwd: "/repo" },
    );
    f.upload.mockImplementation(async () => {
      ownerCurrent = false;
      return { ok: true, value: { threadId: "thread-session-1" } };
    });
    const result = await f.run("diagnostics");
    expect(f.upload).toHaveBeenCalledOnce();
    expect(result.text).toContain("Codex diagnostics sent to OpenAI servers:");
    expect(result.text).toContain("Could not send Codex diagnostics:");
    expect(result.text).toContain("Command owner was revoked");
  });

  it("rejects diagnostics confirmation when the thread auth scope changes", async () => {
    const f = await fixture({
      threadId: "thread-auth-change",
      cwd: "/repo",
      authProfileId: "openai:first",
    });
    const token = readDiagnosticsConfirmationToken(await f.run("diagnostics"));
    await bindingStore.mutate(f.identity, {
      kind: "patch",
      threadId: "thread-auth-change",
      patch: { authProfileId: "openai:second" },
    });
    await expect(f.run(`diagnostics confirm ${token}`)).resolves.toEqual({
      text: "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.",
    });
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("sends supervised diagnostics through the native user-home connection", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    const f = await fixture(
      supervisedTestBinding("thread-supervised-diagnostics"),
      {},
      pluginConfig,
    );
    const token = readDiagnosticsConfirmationToken(await f.run("diagnostics"));
    await f.run(`diagnostics confirm ${token}`);
    expect(f.upload).toHaveBeenCalledWith(
      pluginConfig,
      CODEX_CONTROL_METHODS.feedback,
      expect.objectContaining({ threadId: "thread-supervised-diagnostics" }),
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
  });

  it.each([
    {
      change: "private connection scope",
      replacement: { threadId: "thread-scope-change", cwd: "/repo" },
    },
    {
      change: "supervised connection",
      replacement: {
        ...supervisedTestBinding("thread-scope-change"),
        appServerRuntimeFingerprint: "changed-connection",
      },
    },
  ])("rejects diagnostics confirmation when the $change changes", async ({ replacement }) => {
    let binding: CodexAppServerThreadBinding = supervisedTestBinding("thread-scope-change");
    const f = await fixture(binding, {}, { supervision: { enabled: true } });
    f.deps.bindingStore = { ...bindingStore, read: () => binding };
    const token = readDiagnosticsConfirmationToken(await f.run("diagnostics"));
    binding = replacement;
    await expect(f.run(`diagnostics confirm ${token}`)).resolves.toEqual({
      text: "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.",
    });
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("rejects malformed diagnostics confirmation commands without consuming the token", async () => {
    const f = await fixture();
    const token = readDiagnosticsConfirmationToken(await f.run("diagnostics"));
    for (const action of ["confirm", "cancel"]) {
      await expect(f.run(`diagnostics ${action} ${token} extra`)).resolves.toEqual({
        text: [
          "Usage: /codex diagnostics [note]",
          "Usage: /codex diagnostics confirm <token>",
          "Usage: /codex diagnostics cancel <token>",
        ].join("\n"),
      });
    }
    expect(f.upload).not.toHaveBeenCalled();
    expect((await f.run(`diagnostics confirm ${token}`)).text).toContain(
      "Codex diagnostics sent to OpenAI servers:",
    );
    expect(f.upload).toHaveBeenCalledOnce();
  });

  it("previews exec-approved diagnostics upload without exposing Codex ids", async () => {
    const f = await fixture(
      { threadId: "thread-preview", cwd: "/repo" },
      {
        diagnosticsPreviewOnly: true,
        sessionId: "session-preview",
        sessionKey: "agent:main:telegram:preview",
      },
    );
    const result = await f.run("diagnostics flaky tool call");
    expect(result.text).toBe(
      [
        "Codex runtime thread detected.",
        "Approving diagnostics will also send this thread's feedback bundle to OpenAI servers.",
        "The completed diagnostics reply will list the OpenClaw session ids and Codex thread ids that were sent.",
        "Note: flaky tool call",
        "Included: Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    );
    for (const hidden of [
      "thread-preview",
      "session-preview",
      "agent:main:telegram:preview",
      "To send:",
    ]) {
      expect(result.text).not.toContain(hidden);
    }
    expect(result.interactive).toBeUndefined();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("uploads all Codex diagnostics sessions and reports their channel/thread breakdown", async () => {
    const targets = [
      {
        agentId: "first",
        sessionKey: "agent:first:whatsapp:one",
        sessionId: "session-one",
        channel: "whatsapp",
        threadId: "thread-111",
      },
      {
        agentId: "second",
        sessionKey: "agent:second:discord:two",
        sessionId: "session-two",
        channel: "discord",
        threadId: "thread-222",
      },
    ];
    const f = await fixture(
      { threadId: "thread-111", cwd: "/repo", authProfileId: "openai:first" },
      {
        agentId: "first",
        sessionId: "session-one",
        sessionKey: "agent:first:whatsapp:one",
        channel: "whatsapp",
        diagnosticsSessions: targets,
      },
    );
    await writeTestBinding(
      {
        kind: "session",
        agentId: "second",
        sessionId: "session-two",
        sessionKey: "agent:second:discord:two",
      },
      { threadId: "thread-222", cwd: "/repo", authProfileId: "openai:second" },
    );
    const upload = vi.fn(async (_config: unknown, _method: string, params: unknown) => {
      if (
        !params ||
        typeof params !== "object" ||
        !("threadId" in params) ||
        typeof params.threadId !== "string"
      ) {
        throw new Error("Expected a diagnostics thread id");
      }
      return { ok: true as const, value: { threadId: params.threadId } };
    });
    f.deps.safeCodexControlRequest = upload;
    const prefix = "<@U123> [trusted](https://evil) @here `tick`";
    const padding = "x".repeat(2047 - prefix.length);
    const reason = prefix + padding;
    const request = await f.run(`diagnostics ${reason}😀tail`);
    const token = readDiagnosticsConfirmationToken(request);
    expect(request.text).toContain("Codex runtime threads detected.");
    expect(requireResultText(request).split("\n")).toContain(
      "Note: &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here \uff40tick\uff40" +
        padding,
    );
    for (const target of targets) {
      for (const [label, value] of [
        ["OpenClaw session key", target.sessionKey],
        ["OpenClaw session id", target.sessionId],
        ["Codex thread id", target.threadId],
      ]) {
        expect(request.text).toContain(`${label}: \`${value}\``);
      }
    }
    expect(request.interactive).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              action: { type: "command", command: `/codex diagnostics confirm ${token}` },
              value: `/codex diagnostics confirm ${token}`,
              style: "danger",
            },
            {
              action: { type: "command", command: `/codex diagnostics cancel ${token}` },
              value: `/codex diagnostics cancel ${token}`,
              style: "secondary",
            },
          ],
        },
      ],
    });
    expect(upload).not.toHaveBeenCalled();
    await expect(f.run(`diagnostics confirm ${token}`)).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({ index: 1, ...targets[0]! }),
        "",
        ...expectedDiagnosticsTargetBlock({ index: 2, ...targets[1]! }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(upload).toHaveBeenCalledTimes(2);
    for (const target of targets) {
      expect(upload).toHaveBeenCalledWith(
        undefined,
        CODEX_CONTROL_METHODS.feedback,
        {
          classification: "bug",
          threadId: target.threadId,
          includeLogs: true,
          reason,
          tags: { source: "openclaw-diagnostics", channel: "whatsapp" },
        },
        {
          config: {},
          agentDir: path.join(diagnosticsStateDir, "agents", target.agentId, "agent"),
          assertCurrent: expect.any(Function),
          authProfileId: `openai:${target.agentId}`,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
        },
      );
    }
  });
});
