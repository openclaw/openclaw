import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramMessageContextRuntime } from "./bot-handlers.message-context.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const telegramCfg = {
  groupPolicy: "open" as const,
  groupAllowFrom: ["1"],
  historyLimit: 20,
  groups: { "-1001": { allowFrom: ["1"] } },
};
const cfg: OpenClawConfig = {
  agents: { entries: { main: { default: true } } },
  channels: { telegram: telegramCfg },
};
const chat = { id: -1001, type: "supergroup" as const, title: "QA", is_forum: true };
const me = { id: 99, is_bot: true as const, first_name: "Assistant", username: "qa_bot" };
function message(id: number, text = "ambient " + id, sender = 1, thread = 77): Message {
  return {
    message_id: id,
    chat,
    date: 1700000000 + id,
    text,
    ...(text.startsWith("/")
      ? {
          entities: [
            {
              type: "bot_command" as const,
              offset: 0,
              length: (text.split(/\s/u)[0] ?? text).length,
            },
          ],
        }
      : {}),
    from: {
      id: sender,
      is_bot: sender === me.id,
      first_name: sender === me.id ? "Assistant" : "QA",
    },
    message_thread_id: thread,
    is_topic_message: true,
  } as Message;
}
function runtime() {
  return createTelegramMessageContextRuntime({
    cfg,
    accountId: "default",
    ownerAgentId: "main",
    opts: { token: "test" },
    telegramCfg,
    telegramDeps: {
      resolveStorePath: () => "/tmp/telegram-cached-group-proof/sessions.json",
    } as RegisterTelegramHandlerParams["telegramDeps"],
  });
}
async function record(rt: ReturnType<typeof runtime>, msg: Message) {
  await rt.recordMessageForReplyChain(msg, { scope: "forum", id: msg.message_thread_id }, me.id);
  await rt.markHistoryEligible({
    accountId: "default",
    chatId: msg.chat.id,
    messageIds: [String(msg.message_id)],
    botUserId: me.id,
  });
}
async function prompt(
  rt: ReturnType<typeof runtime>,
  msg: Message,
  options = {},
  historyLimit = 20,
) {
  return rt.buildPromptContextForMessage(
    { message: msg, me } as never,
    msg,
    [],
    cfg,
    { ...telegramCfg, historyLimit },
    options,
  );
}
function messages(value: Awaited<ReturnType<typeof prompt>>) {
  return value.flatMap(
    (entry) => (entry.payload as { messages: { message_id: string; body?: string }[] }).messages,
  );
}

beforeEach(() => {
  resetTelegramMessageCacheForTest();
  resetPluginStateStoreForTests();
  setTelegramRuntime({
    state: {
      openKeyedStore: ((options) =>
        createPluginStateKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
});
afterEach(() => {
  clearTelegramRuntimeForTest();
  resetTelegramMessageCacheForTest();
  resetPluginStateStoreForTests();
});

describe("cached Telegram group context", () => {
  it("hydrates more than twenty ambient messages after restart into the real inbound payload", async () => {
    const first = runtime();
    for (let id = 1; id <= 25; id++) {
      await record(first, message(id));
    }
    resetTelegramMessageCacheForTest();
    const restarted = runtime();
    const current = message(26, "@qa_bot summarize the discussion");
    await record(restarted, current);
    const selected = await prompt(restarted, current);
    expect(messages(selected).map((row) => row.message_id)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 6)),
    );
    const context = await buildTelegramMessageContextForTest({
      message: current as unknown as Record<string, unknown>,
      me,
      cfg,
      historyLimit: 20,
      promptContext: selected,
      options: { forceWasMentioned: true },
      resolveTelegramGroupConfig: () => ({ groupConfig: telegramCfg.groups["-1001"] }),
    });
    expect(context?.ctxPayload.InboundHistory).toHaveLength(20);
    expect(context?.ctxPayload.RawBody).toBe(current.text);
    expect(JSON.stringify(context?.ctxPayload.ChannelStructuredContext)).toContain("ambient 6");
    expect(JSON.stringify(context?.ctxPayload.ChannelStructuredContext)).not.toContain(
      current.text,
    );
  });

  it("retains a rolling cache across successive mentions and honors the self watermark", async () => {
    const rt = runtime();
    await record(rt, message(1));
    await record(rt, message(2, "@qa_bot first mention"));
    expect(messages(await prompt(rt, message(2)))).toHaveLength(1);
    await record(rt, message(3, "answer", me.id));
    await record(rt, message(4, "new ambient"));
    const current = message(5, "@qa_bot second mention");
    await record(rt, current);
    const selected = await prompt(rt, current);
    expect(messages(selected).map((row) => row.message_id)).toEqual(["1", "2", "3", "4"]);
    const context = await buildTelegramMessageContextForTest({
      message: current as unknown as Record<string, unknown>,
      me,
      cfg,
      historyLimit: 20,
      promptContext: selected,
      options: { forceWasMentioned: true },
      resolveTelegramGroupConfig: () => ({ groupConfig: telegramCfg.groups["-1001"] }),
    });
    expect(context?.ctxPayload.InboundHistory?.map((row) => row.messageId)).toEqual(["4"]);
  });

  it("does not promote denied senders, sibling topics or other-bot reset commands", async () => {
    const rt = runtime();
    for (const msg of [
      message(1),
      message(2, "denied", 2),
      message(3, "sibling", 1, 88),
      message(4, "/reset@other_bot"),
      message(5, "now"),
    ]) {
      await record(rt, msg);
    }
    expect(messages(await prompt(rt, message(5))).map((row) => row.message_id)).toEqual(["1"]);
  });

  it.each(["/new", "/reset"])("keeps context when a bot reply contains %s", async (command) => {
    const rt = runtime();
    for (const msg of [message(1), message(2, command, me.id), message(3), message(4, "now")]) {
      await record(rt, msg);
    }
    expect(messages(await prompt(rt, message(4))).map((row) => row.message_id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
  it("honors zero history, reset boundaries and the current message exclusion", async () => {
    const rt = runtime();
    for (const msg of [message(1), message(2, "/reset"), message(3), message(4, "now")]) {
      await record(rt, msg);
    }
    expect(await prompt(rt, message(4), {}, 0)).toEqual([]);
    expect(messages(await prompt(rt, message(4))).map((row) => row.message_id)).toEqual(["3"]);
    expect(
      messages(await prompt(rt, message(4), { promptContextMinTimestampMs: 1700000004000 })),
    ).toEqual([]);
  });

  it("bounds dense cached text by UTF-8 bytes without shortening the current request", async () => {
    const rt = runtime();
    for (let id = 1; id <= 25; id++) {
      await record(rt, message(id, "界".repeat(2000)));
    }
    const current = message(26, "界".repeat(4000));
    await record(rt, current);
    const selected = await prompt(rt, current);
    expect(Buffer.byteLength(JSON.stringify(messages(selected)))).toBeLessThanOrEqual(16384);
    expect(messages(selected).length).toBeLessThan(20);
    expect(current.text).toHaveLength(4000);
  });
});
