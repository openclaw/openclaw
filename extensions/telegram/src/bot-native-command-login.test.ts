import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ModelsAuthLoginFlowOptions } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLoginResult,
  createOwnerLoginConfig,
  exerciseDeferredModelAccess,
  prepareTelegramLoginSessionStore,
  registerLoginCommand,
  type TelegramLoginFlow,
} from "./bot-native-command-login.test-support.js";
import { createTelegramGroupCommandContext } from "./bot-native-commands.fixture-test-support.js";
import {
  deliverReplies,
  createPrivateCommandContext,
  resetNativeCommandMenuMocks,
} from "./bot-native-commands.menu-test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "telegram-login-worker-");

const loginSessionMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
  prepareSessionEntryPatch: vi.fn(),
}));

vi.mock("./bot-native-commands.runtime.js", () => ({
  ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: true })),
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
  getAgentScopedMediaLocalRoots: vi.fn(() => []),
  getSessionEntry: loginSessionMocks.getSessionEntry,
  resolveChunkMode: vi.fn(() => "length"),
  resolveThreadSessionKeys: vi.fn(
    ({
      baseSessionKey,
      parentSessionKey,
    }: {
      baseSessionKey: string;
      parentSessionKey?: string;
    }) => ({
      sessionKey: baseSessionKey,
      parentSessionKey,
    }),
  ),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    getSessionEntry: loginSessionMocks.getSessionEntry,
    resolveStorePath: loginSessionMocks.resolveStorePath,
    prepareSessionEntryPatch: loginSessionMocks.prepareSessionEntryPatch,
  };
});

function resetLoginCommandMocks() {
  resetNativeCommandMenuMocks();
  loginSessionMocks.loadSessionStore.mockReset().mockReturnValue({});
  loginSessionMocks.getSessionEntry
    .mockReset()
    .mockImplementation(
      ({ storePath, sessionKey }: { storePath: string; sessionKey: string }) =>
        loginSessionMocks.loadSessionStore(storePath)[sessionKey],
    );
  loginSessionMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  loginSessionMocks.prepareSessionEntryPatch.mockReset().mockImplementation(async (params) => {
    const current = loginSessionMocks.loadSessionStore(params.storePath)[params.sessionKey];
    if (!current) {
      return null;
    }
    const patch = await params.prepare({ ...current });
    if (params.authority?.kind === "host") {
      params.authority.assertCurrent();
    }
    return patch ? { ...current, ...patch } : current;
  });
}

describe("registerTelegramNativeCommands /login", () => {
  beforeEach(resetLoginCommandMocks);

  it("delivers the core provider menu and its method continuation without starting login", async () => {
    const loginFlow = vi.fn();
    const { handler, nativeCommandCallbackDispatcher } = registerLoginCommand({
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
      loginFlow,
    });
    await handler(createPrivateCommandContext({ match: "", userId: 200 }));
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: expect.stringContaining("Choose a provider") })],
      }),
    );
    expect(loginFlow).not.toHaveBeenCalled();
    await nativeCommandCallbackDispatcher?.({
      botUser: telegramBotInfoForTest,
      callbackQuery: {
        id: "provider-selection",
        from: { id: 200, is_bot: false, first_name: "Owner" },
        chat_instance: "private-chat",
        message: {
          message_id: 101,
          date: 1,
          chat: { id: 100, type: "private", first_name: "Owner" },
        },
      },
      commandText: "/login oauth/openai/openai",
    });
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({ text: expect.stringContaining("Choose how to connect") }),
        ],
      }),
    );
    expect(loginFlow).not.toHaveBeenCalled();
  });

  it("releases the chat lane only after structured device-code delivery", async () => {
    const allowDeviceCode = createDeferred<void>();
    const finishLogin = createDeferred<void>();
    let loginCompleted = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("Preparing Codex login…");
      await allowDeviceCode.promise;
      if (!params.prompter.deviceCode) {
        throw new Error("expected structured device-code delivery");
      }
      await params.prompter.deviceCode({
        title: "OpenAI Codex device code",
        code: "PENDING-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      loginCompleted = true;
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    let handlerReturned = false;
    const handlerTask = handler(createPrivateCommandContext({ match: "codex", userId: 200 })).then(
      () => {
        handlerReturned = true;
      },
    );
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "Preparing Codex login…",
      ),
    );
    expect(handlerReturned).toBe(false);

    allowDeviceCode.resolve();
    await handlerTask;

    expect(loginCompleted).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>PENDING-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login complete. Try your request again now.",
    );

    finishLogin.resolve();
    await vi.waitFor(() => expect(loginCompleted).toBe(true));
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );
  });

  it("routes the login button through the non-blocking native login flow", async () => {
    const finishLogin = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "BUTTON-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      return createLoginResult("openai:codex");
    });
    const { nativeCommandCallbackDispatcher, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });
    if (!nativeCommandCallbackDispatcher) {
      throw new Error("expected login callback dispatcher to be registered");
    }
    const callbackQuery = {
      id: "login-button",
      chat_instance: "login-button-chat",
      data: "tgcmd:/login codex",
      from: { id: 200, is_bot: false, first_name: "Bob", username: "bob" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 100, type: "private" as const, first_name: "Owner" },
        reply_markup: {
          inline_keyboard: [[{ text: "Log in to Codex", callback_data: "tgcmd:/login codex" }]],
        },
      },
    };

    await expect(
      nativeCommandCallbackDispatcher({
        commandText: "/login codex",
        botUser: telegramBotInfoForTest,
        callbackQuery,
      }),
    ).resolves.toEqual({ handled: true, clearButtons: true });

    expect(loginFlow).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>BUTTON-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login complete. Try your request again now.",
    );

    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );
  });

  it.each(["all"] as const)(
    "delivers both long-provider controls and completes deferred %s consent through a fresh dispatcher",
    exerciseDeferredModelAccess,
  );

  it("cancels saved-login consent and rejects its old choice", async () => {
    await exerciseDeferredModelAccess("cancel");
  });

  it("rejects group /login codex without sending the device code publicly", async () => {
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("URL: https://auth.openai.com/codex/device\nCode: SECRET");
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      allowFrom: ["200"],
    });

    await handler(createTelegramGroupCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts).toContain(
      "Provider login requires a private chat or Control UI session. Open a private chat with OpenClaw and send `/login` there.",
    );
    expect(texts.join("\n")).not.toContain("SECRET");
    expect(texts.join("\n")).not.toContain("https://auth.openai.com/codex/device");
  });

  it("rejects /login for authorized senders who are not owners", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "openai",
      methodId: "device-code",
      authRefresh: "refreshed",
      profiles: [],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          allowFrom: { telegram: ["200"] },
          ownerAllowFrom: ["999"],
        },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "Only an OpenClaw owner can sign in here. Ask the owner to connect this provider or grant you owner access.",
    );
  });

  it("names the active provider when another provider is requested in the same Telegram thread", async () => {
    const deferred = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "FIRST-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await deferred.promise;
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(
      createPrivateCommandContext({ match: "openrouter/openrouter-oauth", userId: 200 }),
    );
    deferred.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );

    expect(loginFlow).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "OpenAI sign-in is already in progress. Finish it, or send /login cancel to cancel.",
    );
  });

  it("cancels only the owner's private chat after browser-link delivery", async () => {
    const finish = createDeferred<void>();
    const signals: AbortSignal[] = [];
    let settled = 0;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      if (!params.signal) {
        throw new Error("Expected login cancellation signal.");
      }
      signals.push(params.signal);
      try {
        await params.openUrl?.("https://openrouter.ai/auth?code_challenge=fixture");
        await finish.promise;
        params.signal.throwIfAborted();
        return {
          providerId: "openrouter",
          methodId: "oauth",
          authRefresh: "refreshed",
          profiles: [{ profileId: "openrouter:default", provider: "openrouter", mode: "api_key" }],
        };
      } finally {
        settled += 1;
      }
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      allowFrom: ["200", "201"],
    });
    const command = (match: string, chatId = 100, userId = 200) =>
      handler(createPrivateCommandContext({ match, chatId, userId }));
    try {
      await command("openrouter/openrouter-oauth");
      await command("openrouter/openrouter-oauth", 101);
      expect(signals).toHaveLength(2);
      await command("cancel", 100, 201);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      await command("cancel");
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      expect(sendMessage).toHaveBeenCalledWith(100, "Provider login cancelled for this chat.", {});
      await command("cancel");
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "No provider login is active in this chat.",
        {},
      );
    } finally {
      await command("cancel");
      await command("cancel", 101);
      finish.resolve();
      await vi.waitFor(() => expect(settled).toBe(signals.length));
    }
    expect(loginSessionMocks.prepareSessionEntryPatch).not.toHaveBeenCalled();
  });

  it("rejects credential persistence after the command owner is removed", async () => {
    const deferred = createDeferred<void>();
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const cfg: OpenClawConfig = {
      commands,
      agents: { entries: { main: {} } },
    };
    let currentConfig = cfg;
    const persist = vi.fn();
    const loginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({ title: "Sign in", code: "OWNER-CODE" });
      await deferred.promise;
      opts.assertCurrent?.();
      persist();
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg,
      loginFlow,
      getRuntimeConfig: () => currentConfig,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    currentConfig = { ...cfg, commands: { native: true, ownerAllowFrom: ["999"] } };
    deferred.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
      ),
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the prior Telegram pin when the owner is revoked after patch preparation", async () => {
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const previous: SessionEntry = {
      sessionId: "revoked-telegram-owner-session",
      updatedAt: 1,
      authProfileOverride: "openai:prior",
      authProfileOverrideSource: "user",
    };
    const store = { "agent:main:main": previous };
    loginSessionMocks.loadSessionStore.mockReturnValue(store);
    loginSessionMocks.prepareSessionEntryPatch.mockImplementationOnce(
      async (
        write: Parameters<
          typeof import("openclaw/plugin-sdk/session-store-runtime").prepareSessionEntryPatch
        >[0],
      ) => {
        const patch = await write.prepare({ ...previous }, { existingEntry: previous });
        commands.ownerAllowFrom = ["999"];
        if (write.authority?.kind === "host") {
          write.authority.assertCurrent();
        }
        store["agent:main:main"] = patch ? { ...previous, ...patch } : previous;
        return store["agent:main:main"];
      },
    );
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => createLoginResult("openai:saved"));
    const { handler, sendMessage } = registerLoginCommand({ cfg: { commands }, loginFlow });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(store["agent:main:main"]).toBe(previous);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.",
    );
  });

  it("releases a failed flow before any device code is delivered", async () => {
    const loginFlow = vi.fn(async () => {
      throw new Error("device-code request failed");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).toHaveBeenCalledTimes(2);
    expect(
      sendMessage.mock.calls.filter(
        (call) =>
          call[1] ===
          "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
      ),
    ).toHaveLength(2);
  });

  it("does not report auth failure when only the terminal notification fails", async () => {
    const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "SUCCESS-CODE" });
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      runtime,
    });
    sendMessage.mockResolvedValueOnce({ message_id: 999 });
    sendMessage.mockRejectedValueOnce(new Error("Telegram unavailable"));

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await vi.waitFor(() =>
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("result notification failed"),
      ),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
    );
  });

  it("blocks provider prompts and terminal messages after Telegram stops", async () => {
    const shutdown = new AbortController();
    let loginSettled = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "ABORT-CODE" });
      if (!params.signal) {
        throw new Error("expected login owner signal");
      }
      const signal = params.signal;
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("Telegram stopped"),
              ),
            { once: true },
          );
        });
        throw new Error("unreachable");
      } catch {
        await params.prompter.note("Trouble with device code login?", "OAuth help");
        throw new Error("Telegram stopped");
      } finally {
        loginSettled = true;
      }
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      abortSignal: shutdown.signal,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    shutdown.abort(new Error("Telegram stopped"));
    await vi.waitFor(() => expect(loginSettled).toBe(true));

    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toHaveLength(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("ABORT-CODE");
  });

  it("delivers pending login results through the account sender instead of the retired bot", async () => {
    const finishLogin = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "RESTART-CODE" });
      await finishLogin.promise;
      return createLoginResult("openai:codex");
    });
    const { accountId, handler, sendMessage, sendMessageTelegram } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sendMessage.mockRejectedValue(new Error("retired polling bot"));
    sendMessageTelegram.mockResolvedValueOnce({ messageId: "1000", chatId: "100" });

    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        "telegram:100",
        "OpenAI login complete. Try your request again now.",
        expect.objectContaining({ accountId, token: "token" }),
      ),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it("persists the Telegram login account without caller-thread entry SQL", async () => {
    const { store, scope, queries } = await prepareTelegramLoginSessionStore(
      sessionDirs.make(),
      loginSessionMocks,
    );
    const { handler } = registerLoginCommand({
      accountId: "default",
      cfg: createOwnerLoginConfig(),
      loginFlow: vi.fn<TelegramLoginFlow>(async () => createLoginResult("openai:saved")),
    });
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    expect(loginSessionMocks.prepareSessionEntryPatch).toHaveBeenCalledOnce();
    expect(loginSessionMocks.prepareSessionEntryPatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: scope.sessionKey, storePath: scope.storePath }),
    );
    expect(store.getSessionEntry(scope)?.authProfileOverride).toBe("openai:saved");
    expect(
      queries.filter((query) =>
        /\b(?:session_nodes|session_entry_snapshots|session_windows)\b/i.test(query),
      ),
    ).toEqual([]);
  });

  it("moves a session created while Telegram login is pending to the returned profile", async () => {
    const finishLogin = createDeferred<void>();
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "NEW-SESSION",
      });
      await finishLogin.promise;
      return createLoginResult("openai:new-owner@example.com");
    });
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sessionStore = {
      "agent:main:main": {
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      },
    };
    finishLogin.resolve();

    await vi.waitFor(() =>
      expect(loginSessionMocks.prepareSessionEntryPatch).toHaveBeenCalledTimes(1),
    );
    const update = (
      loginSessionMocks.prepareSessionEntryPatch.mock.calls[0]?.[0] as {
        prepare?: (entry: SessionEntry) => Partial<SessionEntry> | null;
      }
    )?.prepare;
    expect(
      update?.({
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      }),
    ).toEqual({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        {},
      ),
    );
  });

  it("preserves a later user-selected profile on a session created during Telegram login", async () => {
    const finishLogin = createDeferred<void>();
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "LATER-USER-SELECTION",
      });
      await finishLogin.promise;
      return createLoginResult("openai:login-profile");
    });
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sessionStore = {
      "agent:main:main": {
        authProfileOverride: "openai:later-user-profile",
        authProfileOverrideSource: "user",
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      },
    };
    finishLogin.resolve();

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.",
        {},
      ),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });

  it.each([
    {
      authRefresh: "refreshed",
      message:
        'OpenAI login complete. This chat kept its previous account. To use the new sign-in, send `/model "openai/test-model"@"openai:new-owner@example.com" -s`.',
    },
  ] as const)(
    "preserves $authRefresh when Telegram cannot persist the returned session profile",
    async ({ authRefresh, message }) => {
      loginSessionMocks.loadSessionStore.mockReturnValue({
        "agent:main:main": {
          authProfileOverride: "openai:old-owner@example.com",
          modelOverride: "test-model",
          sessionId: "sess-main",
          updatedAt: 1,
        },
      });
      loginSessionMocks.prepareSessionEntryPatch.mockRejectedValueOnce(new Error("write failed"));
      const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
        createLoginResult("openai:new-owner@example.com", authRefresh),
      );
      const { handler, sendMessage } = registerLoginCommand({
        accountId: "default",
        cfg: {
          commands: { native: true, ownerAllowFrom: ["200"] },
        } as OpenClawConfig,
        allowFrom: ["200"],
        loginFlow: runModelsAuthLoginFlow,
      });

      await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

      expect(sendMessage).toHaveBeenCalledWith(100, message, {});
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        expect.stringContaining("kept its previous account"),
        {},
      );
      expect(sendMessage).not.toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        expect.any(Object),
      );
    },
  );

  it("revalidates an unchanged Telegram profile after device login", async () => {
    const previousEntry = {
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
      sessionId: "sess-main",
      updatedAt: 1,
    };
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": previousEntry,
    });
    loginSessionMocks.prepareSessionEntryPatch.mockImplementationOnce(async (params) => {
      const concurrentEntry = {
        ...previousEntry,
        authProfileOverride: "openai:concurrent-owner@example.com",
        updatedAt: 2,
      };
      const patch = await params.prepare({ ...concurrentEntry });
      if (params.authority?.kind === "host") {
        params.authority.assertCurrent();
      }
      return patch ? { ...concurrentEntry, ...patch } : concurrentEntry;
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
      createLoginResult("openai:owner@example.com"),
    );
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.",
      {},
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });
});
