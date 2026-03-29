import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasControlCommand } from "../../../src/auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../../src/auto-reply/inbound-debounce.js";
import { createPluginRuntimeMock } from "../../../test/helpers/plugins/plugin-runtime-mock.js";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async () => {}));
const sendCardFeishuMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "m1", chatId: "c1" })));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./bot.js", async () => {
  const actual = await vi.importActual<typeof import("./bot.js")>("./bot.js");
  return {
    ...actual,
    handleFeishuMessage: handleFeishuMessageMock,
  };
});

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendCardFeishu: sendCardFeishuMock,
  };
});

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

function buildAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createBotMenuEvent(params: { eventKey: string; timestamp: string }) {
  return {
    event_key: params.eventKey,
    timestamp: params.timestamp,
    operator: {
      operator_id: {
        open_id: "ou_user1",
        user_id: "user_1",
        union_id: "union_1",
      },
    },
  };
}

async function registerHandlers() {
  setFeishuRuntime(
    createPluginRuntimeMock({
      channel: {
        debounce: {
          createInboundDebouncer,
          resolveInboundDebounceMs,
        },
        text: {
          hasControlCommand,
        },
      },
    }),
  );
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({ register });

  await monitorSingleAccount({
    cfg: {} as ClawdbotConfig,
    account: buildAccount(),
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as RuntimeEnv,
    botOpenIdSource: {
      kind: "prefetched",
      botOpenId: "ou_bot",
      botName: "Bot",
    },
  });

  const onBotMenu = handlers["application.bot.menu_v6"];
  if (!onBotMenu) {
    throw new Error("missing application.bot.menu_v6 handler");
  }
  return onBotMenu;
}

describe("Feishu bot menu handler", () => {
  beforeEach(() => {
    handlers = {};
    vi.clearAllMocks();
    process.env.OPENCLAW_STATE_DIR = `/tmp/openclaw-feishu-bot-menu-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
      return;
    }
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  });

  it("opens the quick-action launcher card at the webhook/event layer", async () => {
    const onBotMenu = await registerHandlers();

    await onBotMenu(createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000000" }));

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou_user1",
        card: expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({ content: "Quick actions" }),
          }),
        }),
      }),
    );
    expect(handleFeishuMessageMock).not.toHaveBeenCalled();
  });

  it("does not block bot-menu handling on quick-action launcher send", async () => {
    const onBotMenu = await registerHandlers();
    let resolveSend: (() => void) | undefined;
    sendCardFeishuMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = () => resolve({ messageId: "m1", chatId: "c1" });
        }),
    );

    const pending = onBotMenu(
      createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000001" }),
    );
    let settled = false;
    pending.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(settled).toBe(true);
    });

    resolveSend?.();
    await pending;
  });

  it("falls back to the legacy /menu synthetic message path for unrelated bot menu keys", async () => {
    const onBotMenu = await registerHandlers();

    await onBotMenu(createBotMenuEvent({ eventKey: "custom-key", timestamp: "1700000000002" }));

    expect(handleFeishuMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/menu custom-key"}',
          }),
        }),
      }),
    );
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy /menu path when launcher rendering fails", async () => {
    const onBotMenu = await registerHandlers();
    sendCardFeishuMock.mockRejectedValueOnce(new Error("boom"));

    await onBotMenu(createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000003" }));

    await vi.waitFor(() => {
      expect(handleFeishuMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            message: expect.objectContaining({
              content: '{"text":"/menu quick-actions"}',
            }),
          }),
        }),
      );
    });
  });
});
