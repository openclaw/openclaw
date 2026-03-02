import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasControlCommand } from "../../../src/auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../../src/auto-reply/inbound-debounce.js";
import * as dedup from "./dedup.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async () => {}));
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("./bot.js", async () => {
  const actual = await vi.importActual<typeof import("./bot.js")>("./bot.js");
  return {
    ...actual,
    handleFeishuMessage: handleFeishuMessageMock,
  };
});

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

function buildConfig(): ClawdbotConfig {
  return {
    messages: {
      inbound: {
        debounceMs: 0,
        byChannel: {
          feishu: 20,
        },
      },
    },
    channels: {
      feishu: {
        enabled: true,
      },
    },
  } as ClawdbotConfig;
}

function buildAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test",
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createTextEvent(params: {
  messageId: string;
  text: string;
  senderId?: string;
  mentions?: Array<{
    key: string;
    id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    name: string;
    tenant_key?: string;
  }>;
}) {
  const senderId = params.senderId ?? "ou_sender";
  return {
    sender: {
      sender_id: { open_id: senderId },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId,
      chat_id: "oc_group_1",
      chat_type: "group" as const,
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      mentions: params.mentions,
    },
  };
}

async function setupMonitor() {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({
    register,
  });

  await monitorSingleAccount({
    cfg: buildConfig(),
    account: buildAccount(),
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as RuntimeEnv,
    botOpenIdSource: { kind: "prefetched", botOpenId: "ou_bot" },
  });

  return handlers["im.message.receive_v1"];
}

describe("Feishu inbound debounce regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers = {};
    handleFeishuMessageMock.mockClear();
    setFeishuRuntime({
      channel: {
        debounce: {
          createInboundDebouncer,
          resolveInboundDebounceMs,
        },
        text: {
          hasControlCommand,
        },
      },
    } as unknown as PluginRuntime);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves bot mentions in merged dispatch payload", async () => {
    vi.spyOn(dedup, "tryRecordMessage").mockReturnValue(true);
    vi.spyOn(dedup, "tryRecordMessagePersistent").mockResolvedValue(true);
    const onMessage = await setupMonitor();
    await onMessage(
      createTextEvent({
        messageId: "om_1",
        text: "@bot first",
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_bot" },
            name: "bot",
          },
        ],
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_2", text: "followup" }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = handleFeishuMessageMock.mock.calls[0]?.[0];
    const mergedMentions = firstCall?.event.message.mentions ?? [];
    expect(mergedMentions.some((mention) => mention.id.open_id === "ou_bot")).toBe(true);
    const content = JSON.parse(firstCall?.event.message.content ?? "{}") as { text?: string };
    expect(content.text).toContain("first");
    expect(content.text).toContain("followup");
  });

  it("records suppressed merged message ids in dedupe before dispatch", async () => {
    const memorySpy = vi.spyOn(dedup, "tryRecordMessage").mockReturnValue(true);
    const persistentSpy = vi.spyOn(dedup, "tryRecordMessagePersistent").mockResolvedValue(true);
    const onMessage = await setupMonitor();

    await onMessage(createTextEvent({ messageId: "om_1", text: "first" }));
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_2", text: "second" }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(memorySpy).toHaveBeenCalledWith("default:om_1");
    expect(memorySpy).not.toHaveBeenCalledWith("default:om_2");
    expect(persistentSpy).toHaveBeenCalledWith("om_1", "default", expect.any(Function));
    expect(persistentSpy).not.toHaveBeenCalledWith("om_2", "default", expect.any(Function));
    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const dispatchOrder = handleFeishuMessageMock.mock.invocationCallOrder[0];
    expect(memorySpy.mock.invocationCallOrder[0]).toBeLessThan(dispatchOrder);
    expect(persistentSpy.mock.invocationCallOrder[0]).toBeLessThan(dispatchOrder);
  });
});
