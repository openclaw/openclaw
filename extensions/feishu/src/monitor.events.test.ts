import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuWSClientMock = vi.hoisted(() => vi.fn());
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn(() => true),
  runChatMemberBotAdded: vi.fn(),
  runChatMemberBotDeleted: vi.fn(),
  runChatMemberUserAdded: vi.fn(),
  runChatMemberUserDeleted: vi.fn(),
  runChatMemberUserWithdrawn: vi.fn(),
}));

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuWSClient: createFeishuWSClientMock,
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("openclaw/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk")>();
  return {
    ...actual,
    getGlobalHookRunner: () => hookRunnerMocks,
  };
});

import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";

type RegisteredHandlers = Record<string, (data: unknown) => Promise<void>>;

function buildWebSocketConfig(accountId = "default"): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          [accountId]: {
            enabled: true,
            appId: "cli_test",
            appSecret: "secret_test",
            connectionMode: "websocket",
          },
        },
      },
    },
  } as ClawdbotConfig;
}

async function waitForRegisterCall(registerMock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if (registerMock.mock.calls.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("event dispatcher handlers were not registered");
}

async function startMonitorAndGetHandlers(): Promise<{
  handlers: RegisteredHandlers;
  stop: () => Promise<void>;
}> {
  const registerMock = vi.fn();
  createEventDispatcherMock.mockReturnValue({ register: registerMock });
  createFeishuWSClientMock.mockReturnValue({ start: vi.fn() });
  probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "ou_bot_default" });

  const abortController = new AbortController();
  const monitorPromise = monitorFeishuProvider({
    config: buildWebSocketConfig(),
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    abortSignal: abortController.signal,
  });

  await waitForRegisterCall(registerMock);
  const handlers = registerMock.mock.calls[0]?.[0] as RegisteredHandlers;
  if (!handlers) {
    throw new Error("missing registered handlers");
  }

  return {
    handlers,
    stop: async () => {
      abortController.abort();
      await monitorPromise;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hookRunnerMocks.hasHooks.mockReturnValue(true);
});

afterEach(() => {
  stopFeishuMonitor();
});

describe("monitorFeishuProvider chat member relay", () => {
  it("forwards Feishu member events to hook runner with normalized payload", async () => {
    const { handlers, stop } = await startMonitorAndGetHandlers();
    try {
      await handlers["im.chat.member.bot.added_v1"]({
        chat_id: "oc_group_1",
        operator_id: { open_id: "ou_operator" },
        external: false,
      });
      await handlers["im.chat.member.bot.deleted_v1"]({
        chat_id: "oc_group_1",
      });
      await handlers["im.chat.member.user.added_v1"]({
        chat_id: "oc_group_1",
        users: [
          { name: "Alice", user_id: { open_id: "ou_alice", union_id: "on_alice" } },
          { name: "Ghost", user_id: { union_id: "on_ghost" } },
          { name: "Bob", user_id: { open_id: "ou_bob" } },
        ],
      });
      await handlers["im.chat.member.user.deleted_v1"]({
        chat_id: "oc_group_1",
        users: [
          { name: "Alice", user_id: { open_id: "ou_alice", union_id: "on_alice" } },
          { name: "NoOpen", user_id: { union_id: "on_none" } },
        ],
      });
      await handlers["im.chat.member.user.withdrawn_v1"]({
        chat_id: "oc_group_1",
        users: [
          { name: "Bob", user_id: { open_id: "ou_bob", union_id: "on_bob" } },
          { name: "NoOpen", user_id: {} },
        ],
      });

      expect(hookRunnerMocks.runChatMemberBotAdded).toHaveBeenCalledWith(
        { chatId: "oc_group_1" },
        { channelId: "feishu", accountId: "default" },
      );
      expect(hookRunnerMocks.runChatMemberBotDeleted).toHaveBeenCalledWith(
        { chatId: "oc_group_1" },
        { channelId: "feishu", accountId: "default" },
      );
      expect(hookRunnerMocks.runChatMemberUserAdded).toHaveBeenCalledWith(
        {
          chatId: "oc_group_1",
          users: [
            { openId: "ou_alice", unionId: "on_alice", name: "Alice" },
            { openId: "ou_bob", unionId: undefined, name: "Bob" },
          ],
        },
        { channelId: "feishu", accountId: "default" },
      );
      expect(hookRunnerMocks.runChatMemberUserDeleted).toHaveBeenCalledWith(
        {
          chatId: "oc_group_1",
          users: [{ openId: "ou_alice", unionId: "on_alice", name: "Alice" }],
        },
        { channelId: "feishu", accountId: "default" },
      );
      expect(hookRunnerMocks.runChatMemberUserWithdrawn).toHaveBeenCalledWith(
        {
          chatId: "oc_group_1",
          users: [{ openId: "ou_bob", unionId: "on_bob", name: "Bob" }],
        },
        { channelId: "feishu", accountId: "default" },
      );
    } finally {
      await stop();
    }
  });

  it("skips member relay when hook is not registered or chat_id is empty", async () => {
    const { handlers, stop } = await startMonitorAndGetHandlers();
    try {
      hookRunnerMocks.hasHooks.mockReturnValue(false);
      await handlers["im.chat.member.bot.added_v1"]({ chat_id: "oc_group_1" });
      await handlers["im.chat.member.user.added_v1"]({
        chat_id: "oc_group_1",
        users: [{ name: "Alice", user_id: { open_id: "ou_alice" } }],
      });
      expect(hookRunnerMocks.runChatMemberBotAdded).not.toHaveBeenCalled();
      expect(hookRunnerMocks.runChatMemberUserAdded).not.toHaveBeenCalled();

      hookRunnerMocks.hasHooks.mockReturnValue(true);
      await handlers["im.chat.member.bot.deleted_v1"]({ chat_id: "" });
      await handlers["im.chat.member.user.deleted_v1"]({
        chat_id: "",
        users: [{ name: "Alice", user_id: { open_id: "ou_alice" } }],
      });
      await handlers["im.chat.member.user.withdrawn_v1"]({
        users: [{ name: "Alice", user_id: { open_id: "ou_alice" } }],
      });
      expect(hookRunnerMocks.runChatMemberBotDeleted).not.toHaveBeenCalled();
      expect(hookRunnerMocks.runChatMemberUserDeleted).not.toHaveBeenCalled();
      expect(hookRunnerMocks.runChatMemberUserWithdrawn).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  });
});
