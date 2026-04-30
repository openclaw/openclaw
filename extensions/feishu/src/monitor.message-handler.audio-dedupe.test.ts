import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

function buildCfg(): ClawdbotConfig {
  return {
    messages: { inbound: { debounceMs: 0 } },
    channels: { feishu: { enabled: true } },
  } as ClawdbotConfig;
}

function buildCore(): PluginRuntime {
  return {
    channel: {
      debounce: { createInboundDebouncer, resolveInboundDebounceMs },
      text: { hasControlCommand },
    },
  } as unknown as PluginRuntime;
}

function createAudioEvent(params: { messageId: string; fileKey: string }): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
    message: {
      message_id: params.messageId,
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "audio",
      content: JSON.stringify({ file_key: params.fileKey, duration: 1000 }),
    },
  };
}

function createTextEvent(messageId: string, text = "hi"): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
    message: {
      message_id: messageId,
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
  };
}

type Recorded = { messageId: string; namespace: string };

function buildHandlerHarness() {
  const handleMessage = vi.fn(async (_params: { event: FeishuMessageEvent }) => {});
  const recorded: Recorded[] = [];
  const processedSet = new Set<string>();
  const hasProcessedMessage = vi.fn(async (messageId: string | undefined | null) => {
    return Boolean(messageId) && processedSet.has(String(messageId));
  });
  const recordProcessedMessage = vi.fn(
    async (messageId: string | undefined | null, namespace: string) => {
      if (messageId) {
        processedSet.add(messageId);
        recorded.push({ messageId, namespace });
      }
      return true;
    },
  );
  const handler = createFeishuMessageReceiveHandler({
    cfg: buildCfg(),
    core: buildCore(),
    accountId: "default",
    chatHistories: new Map(),
    handleMessage,
    resolveDebounceText: ({ event, botOpenId, botName }) =>
      parseFeishuMessageEvent(event, botOpenId, botName).content,
    hasProcessedMessage,
    recordProcessedMessage,
  });
  return { handler, handleMessage, recordProcessedMessage, recorded };
}

describe("createFeishuMessageReceiveHandler audio dedupe (#75057)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches both audios when the same message_id is reused for distinct uploads", async () => {
    const { handler, handleMessage } = buildHandlerHarness();

    await handler(createAudioEvent({ messageId: "om_dup_distinct", fileKey: "audio_alpha" }));
    await handler(createAudioEvent({ messageId: "om_dup_distinct", fileKey: "audio_beta" }));

    expect(handleMessage).toHaveBeenCalledTimes(2);
    const dispatched = handleMessage.mock.calls.map((call) => {
      const params = call[0] as { event: FeishuMessageEvent };
      const parsed = JSON.parse(params.event.message.content) as { file_key?: string };
      return parsed.file_key;
    });
    expect(dispatched).toEqual(["audio_alpha", "audio_beta"]);
  });

  it("still drops a true repeat (same message_id and same file_key)", async () => {
    const { handler, handleMessage } = buildHandlerHarness();

    await handler(createAudioEvent({ messageId: "om_dup_repeat", fileKey: "audio_gamma" }));
    await handler(createAudioEvent({ messageId: "om_dup_repeat", fileKey: "audio_gamma" }));

    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("still drops duplicate text events with the same message_id", async () => {
    const { handler, handleMessage } = buildHandlerHarness();

    await handler(createTextEvent("om_text_dup_unique"));
    await handler(createTextEvent("om_text_dup_unique"));

    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});
