import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type {
  getSessionEntryAsync,
  prepareSessionEntryPatch,
  SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
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
let sessionStore: Record<string, SessionEntry>;
const completed = "OpenAI login complete. Try your request again now.";
const kept =
  "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.";
const failed =
  "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.";
const ownerContext = (match = "codex", chatId = 100, userId = 200) =>
  createPrivateCommandContext({ match, chatId, userId });
type Send = Awaited<ReturnType<typeof registerLoginCommand>>["sendMessage"];
const expectSent = (send: Send, text: unknown, options: unknown = {}) =>
  expect(send).toHaveBeenCalledWith(100, text, options);
const expectMenu = (text: string) =>
  expect(deliverReplies).toHaveBeenLastCalledWith(
    expect.objectContaining({
      replies: [expect.objectContaining({ text: expect.stringContaining(text) })],
    }),
  );
const messages = (send: Send) => send.mock.calls.map((call) => String(call[1]));
function expectKept(send: Send) {
  expect(send).toHaveBeenCalledWith(100, kept, {});
  expect(send).not.toHaveBeenCalledWith(100, completed, expect.any(Object));
}
type SessionWrite = Parameters<typeof prepareSessionEntryPatch>[0];
const sessionEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "sess-main",
  updatedAt: 1,
  ...overrides,
});
function pendingLogin(
  code: string,
  profile = "openai:codex",
  title = "OpenAI Codex device code",
  details: { expiresInMinutes?: number; message?: string } = {},
) {
  const finish = createDeferred<void>();
  const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
    await params.prompter.deviceCode?.({ title, code, ...details });
    await finish.promise;
    return createLoginResult(profile);
  });
  return { finish, loginFlow };
}
const savedLogin = (profile: string) =>
  vi.fn<TelegramLoginFlow>(async () => createLoginResult(profile));
const registerOwnedLogin = (
  loginFlow: TelegramLoginFlow,
  overrides: Partial<Parameters<typeof registerLoginCommand>[0]> = {},
) => registerLoginCommand({ cfg: createOwnerLoginConfig(), loginFlow, ...overrides });
const registerSessionLogin = (loginFlow: TelegramLoginFlow) =>
  registerOwnedLogin(loginFlow, {
    accountId: "default",
    cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
  });

const sessionMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn<typeof getSessionEntryAsync>(),
  resolveStorePath: vi.fn(),
  prepareSessionEntryPatch: vi.fn(),
  recordDeliveredCommandExchange: vi.fn(async () => ({
    ok: true,
    target: { sessionId: "login-session" },
  })),
}));

// mock-isolation: Keep session database startup outside the command fixture.
vi.mock("./bot-native-commands.runtime.js", () => ({
  ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: true })),
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
  getAgentScopedMediaLocalRoots: vi.fn(() => []),
  getSessionEntryAsync: sessionMocks.getSessionEntry,
  resolveStorePath: sessionMocks.resolveStorePath,
  recordDeliveredCommandExchange: sessionMocks.recordDeliveredCommandExchange,
  resolveChunkMode: vi.fn(() => "length"),
  resolveThreadSessionKeys: vi.fn(
    ({
      baseSessionKey,
      parentSessionKey,
    }: {
      baseSessionKey: string;
      parentSessionKey?: string;
    }) => ({ sessionKey: baseSessionKey, parentSessionKey }),
  ),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    getSessionEntryAsync: sessionMocks.getSessionEntry,
    resolveStorePath: sessionMocks.resolveStorePath,
    prepareSessionEntryPatch: sessionMocks.prepareSessionEntryPatch,
  };
});

function resetLoginCommandMocks() {
  resetNativeCommandMenuMocks();
  sessionMocks.recordDeliveredCommandExchange.mockClear();
  sessionStore = {};
  sessionMocks.getSessionEntry
    .mockReset()
    .mockImplementation(async ({ sessionKey }) => sessionStore[sessionKey]);
  sessionMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  sessionMocks.prepareSessionEntryPatch.mockReset().mockImplementation(async (params) => {
    const current = sessionStore[params.sessionKey];
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
    const { handler, nativeCommandCallbackDispatcher } = await registerLoginCommand({
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
      loginFlow,
    });
    await handler(ownerContext(""));
    expectMenu("Choose a provider");
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
    expectMenu("Choose how to connect");
    expect(loginFlow).not.toHaveBeenCalled();
  });

  it("releases the chat lane only after structured device-code delivery", async () => {
    const allowDeviceCode = createDeferred<void>();
    const finishLogin = createDeferred<void>();
    let loginCompleted = false;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.note("Preparing Codex login…");
      await allowDeviceCode.promise;
      assert(params.prompter.deviceCode, "expected structured device-code delivery");
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
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow);

    let handlerReturned = false;
    const handlerTask = handler(ownerContext()).then(() => {
      handlerReturned = true;
    });
    await vi.waitFor(() => expect(messages(sendMessage)).toContain("Preparing Codex login…"));
    expect(handlerReturned).toBe(false);

    allowDeviceCode.resolve();
    await handlerTask;

    expect(loginCompleted).toBe(false);
    expectSent(
      sendMessage,
      expect.stringContaining("Code: <code>PENDING-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(messages(sendMessage)).not.toContain(completed);

    finishLogin.resolve();
    await vi.waitFor(() => expect(loginCompleted).toBe(true));
    await vi.waitFor(() => expect(messages(sendMessage)).toContain(completed));
  });

  it("routes the login button through the non-blocking native login flow", async () => {
    const { finish: finishLogin, loginFlow } = pendingLogin(
      "BUTTON-CODE",
      "openai:codex",
      "OpenAI Codex device code",
      {
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      },
    );
    const { nativeCommandCallbackDispatcher, sendMessage } = await registerOwnedLogin(loginFlow);
    assert(nativeCommandCallbackDispatcher, "expected login callback dispatcher to be registered");
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
    expectSent(
      sendMessage,
      expect.stringContaining("Code: <code>BUTTON-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(messages(sendMessage)).not.toContain(completed);

    finishLogin.resolve();
    await vi.waitFor(() => expect(messages(sendMessage)).toContain(completed));
  });

  it.each(["all", "cancel"] as const)(
    "delivers long-provider controls and resolves deferred consent (%s) through a fresh dispatcher",
    exerciseDeferredModelAccess,
  );

  it("rejects group /login codex without sending the device code publicly", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.note("URL: https://auth.openai.com/codex/device\nCode: SECRET");
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow, { allowFrom: ["200"] });

    await handler(createTelegramGroupCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    const texts = messages(sendMessage);
    expect(texts).toContain(
      "Provider login requires a private chat or Control UI session. Open a private chat with OpenClaw and send `/login` there.",
    );
    expect(texts.join("\n")).not.toContain("SECRET");
    expect(texts.join("\n")).not.toContain("https://auth.openai.com/codex/device");
  });

  it("rejects /login for authorized senders who are not owners", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>();
    const { handler, sendMessage } = await registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          allowFrom: { telegram: ["200"] },
          ownerAllowFrom: ["999"],
        },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(ownerContext());

    expect(loginFlow).not.toHaveBeenCalled();
    expect(messages(sendMessage)).toContain(
      "Only an OpenClaw owner can sign in here. Ask the owner to connect this provider or grant you owner access.",
    );
  });

  it("names the active provider when another provider is requested in the same Telegram thread", async () => {
    const { finish, loginFlow } = pendingLogin("FIRST-CODE");
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow);

    await handler(ownerContext());
    await handler(ownerContext("openrouter/openrouter-oauth"));
    finish.resolve();
    await vi.waitFor(() => expect(messages(sendMessage)).toContain(completed));

    expect(loginFlow).toHaveBeenCalledTimes(1);
    expect(messages(sendMessage)).toContain(
      "OpenAI sign-in is already in progress. Finish it, or send /login cancel to cancel.",
    );
  });

  it("cancels only the owner's private chat after browser-link delivery", async () => {
    const finish = createDeferred<void>();
    const signals: AbortSignal[] = [];
    let settled = 0;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      assert(params.signal, "Expected login cancellation signal.");
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
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow, {
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
      expectSent(sendMessage, "No provider login is active in this chat.");
    } finally {
      await command("cancel");
      await command("cancel", 101);
      finish.resolve();
      await vi.waitFor(() => expect(settled).toBe(signals.length));
    }
    expect(sessionMocks.prepareSessionEntryPatch).not.toHaveBeenCalled();
  });

  it("rejects credential persistence after the command owner is removed", async () => {
    const deferred = createDeferred<void>();
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const cfg: OpenClawConfig = { commands, agents: { entries: { main: {} } } };
    let currentConfig = cfg;
    const persist = vi.fn();
    const loginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({ title: "Sign in", code: "OWNER-CODE" });
      await deferred.promise;
      opts.assertCurrent?.();
      persist();
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = await registerLoginCommand({
      cfg,
      loginFlow,
      getRuntimeConfig: () => currentConfig,
    });

    await handler(ownerContext());
    currentConfig = { ...cfg, commands: { native: true, ownerAllowFrom: ["999"] } };
    deferred.resolve();
    await vi.waitFor(() => expect(messages(sendMessage)).toContain(failed));
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the prior Telegram pin when the owner is revoked after patch preparation", async () => {
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const previous = sessionEntry({
      sessionId: "revoked-telegram-owner-session",
      authProfileOverride: "openai:prior",
      authProfileOverrideSource: "user",
    });
    const store = { "agent:main:main": previous };
    sessionStore = store;
    sessionMocks.prepareSessionEntryPatch.mockImplementationOnce(async (write: SessionWrite) => {
      const patch = await write.prepare({ ...previous }, { existingEntry: previous });
      commands.ownerAllowFrom = ["999"];
      if (write.authority?.kind === "host") {
        write.authority.assertCurrent();
      }
      store["agent:main:main"] = patch ? { ...previous, ...patch } : previous;
      return store["agent:main:main"];
    });
    const loginFlow = savedLogin("openai:saved");
    const { handler, sendMessage } = await registerLoginCommand({ cfg: { commands }, loginFlow });

    await handler(ownerContext());

    expect(store["agent:main:main"]).toBe(previous);
    expect(messages(sendMessage)).toContain(kept);
  });

  it("releases a failed flow before any device code is delivered", async () => {
    const loginFlow = vi.fn(async () => {
      throw new Error("device-code request failed");
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow);
    await handler(ownerContext());
    await handler(ownerContext());

    expect(loginFlow).toHaveBeenCalledTimes(2);
    expect(messages(sendMessage).filter((text) => text === failed)).toHaveLength(2);
  });

  it("does not report auth failure when only the terminal notification fails", async () => {
    const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "SUCCESS-CODE" });
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow, { runtime });
    sendMessage.mockResolvedValueOnce({ message_id: 999 });
    sendMessage.mockRejectedValueOnce(new Error("Telegram unavailable"));

    await handler(ownerContext());
    await vi.waitFor(() =>
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("result notification failed"),
      ),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(messages(sendMessage)).not.toContain(failed);
  });

  it("blocks provider prompts and terminal messages after Telegram stops", async () => {
    const shutdown = new AbortController();
    let loginSettled = false;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "ABORT-CODE" });
      assert(params.signal, "expected login owner signal");
      const signal = params.signal;
      try {
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Telegram stopped")), {
            once: true,
          });
        });
      } catch {
        await params.prompter.note("Trouble with device code login?", "OAuth help");
        throw new Error("Telegram stopped");
      } finally {
        loginSettled = true;
      }
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow, {
      abortSignal: shutdown.signal,
    });

    await handler(ownerContext());
    shutdown.abort(new Error("Telegram stopped"));
    await vi.waitFor(() => expect(loginSettled).toBe(true));

    expect(messages(sendMessage)).toHaveLength(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("ABORT-CODE");
  });

  it("delivers pending login results through the account sender instead of the retired bot", async () => {
    const { finish: finishLogin, loginFlow } = pendingLogin(
      "RESTART-CODE",
      "openai:codex",
      "Codex login",
    );
    const { accountId, handler, sendMessage, sendMessageTelegram } =
      await registerOwnedLogin(loginFlow);

    await handler(ownerContext());
    sendMessage.mockRejectedValue(new Error("retired polling bot"));
    sendMessageTelegram.mockResolvedValueOnce({ messageId: "1000", chatId: "100" });

    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        "telegram:100",
        completed,
        expect.objectContaining({ accountId, token: "token" }),
      ),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it("persists the Telegram login account without caller-thread entry SQL", async () => {
    const { store, scope } = await prepareTelegramLoginSessionStore(
      sessionDirs.make(),
      sessionMocks,
    );
    const { handler } = await registerOwnedLogin(savedLogin("openai:saved"), {
      accountId: "default",
    });
    const sql = observeHostDataSql();
    try {
      await handler(ownerContext());
    } finally {
      sql.restore();
    }
    expect(sessionMocks.prepareSessionEntryPatch).toHaveBeenCalledOnce();
    expect(sessionMocks.prepareSessionEntryPatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: scope.sessionKey, storePath: scope.storePath }),
    );
    expect(store.getSessionEntry(scope)?.authProfileOverride).toBe("openai:saved");
    expect(
      sql.queries.filter((query) =>
        /\b(?:session_nodes|session_entry_snapshots|session_windows)\b/i.test(query),
      ),
    ).toEqual([]);
  });

  it.each([
    ["adopts a session created during login", "NEW", "openai:new-owner@example.com", undefined],
    ["keeps a later user selection", "LATER", "openai:login-profile", "openai:later-user-profile"],
  ] as const)("%s", async (_name, code, profile, laterProfile) => {
    const { finish, loginFlow } = pendingLogin(code, profile);
    const { handler, sendMessage } = await registerSessionLogin(loginFlow);
    await handler(ownerContext());
    const created = sessionEntry({ sessionId: "sess-created-during-login", updatedAt: 2 });
    sessionStore = {
      "agent:main:main": laterProfile
        ? { ...created, authProfileOverride: laterProfile, authProfileOverrideSource: "user" }
        : created,
    };
    finish.resolve();
    if (laterProfile) {
      await vi.waitFor(() => expectSent(sendMessage, kept));
      expect(sendMessage).not.toHaveBeenCalledWith(100, completed, expect.any(Object));
    } else {
      await vi.waitFor(() =>
        expect(sessionMocks.prepareSessionEntryPatch).toHaveBeenCalledTimes(1),
      );
      const update = (
        sessionMocks.prepareSessionEntryPatch.mock.calls[0]?.[0] as {
          prepare?: (entry: SessionEntry) => Partial<SessionEntry> | null;
        }
      )?.prepare;
      expect(update?.(created)).toEqual({
        authProfileOverride: "openai:new-owner@example.com",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: undefined,
      });
      await vi.waitFor(() => expectSent(sendMessage, completed));
    }
  });

  it.each([
    [
      "write fails after refresh",
      true,
      "openai:old-owner@example.com",
      "openai:new-owner@example.com",
    ],
    ["rechecks a concurrent pin", false, "openai:owner@example.com", "openai:owner@example.com"],
  ] as const)("%s", async (_name, writeFailed, prior, profile) => {
    const previous = sessionEntry({
      authProfileOverride: prior,
      ...(writeFailed ? { modelOverride: "test-model" } : { authProfileOverrideSource: "user" }),
    });
    sessionStore = { "agent:main:main": previous };
    if (writeFailed) {
      sessionMocks.prepareSessionEntryPatch.mockRejectedValueOnce(new Error("write failed"));
    } else {
      sessionMocks.prepareSessionEntryPatch.mockImplementationOnce(async (params) => {
        const current = {
          ...previous,
          authProfileOverride: "openai:concurrent-owner@example.com",
          updatedAt: 2,
        };
        const patch = await params.prepare({ ...current });
        if (params.authority?.kind === "host") {
          params.authority.assertCurrent();
        }
        return patch ? { ...current, ...patch } : current;
      });
    }
    const { handler, sendMessage } = await registerSessionLogin(savedLogin(profile));
    await handler(ownerContext());
    if (writeFailed) {
      expectSent(
        sendMessage,
        'OpenAI login complete. This chat kept its previous account. To use the new sign-in, send `/model "openai/test-model"@"openai:new-owner@example.com" -s`.',
      );
      expect(sendMessage).not.toHaveBeenCalledWith(100, completed, expect.any(Object));
    } else {
      expectKept(sendMessage);
    }
  });
});
