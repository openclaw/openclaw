// Drift lock for the rewind cache-prune proof. The core integration test
// (src/channels/inbound-event/session-transcript-context.rewind.integration.test.ts)
// seeds its chat window from src/__fixtures__/telegram-rewind-chat-window.json
// because core test graphs may not include extension files. This test rebuilds
// that exact window through the real pipeline (message cache, outbound record
// with a projection cursor, and buildPromptContextForMessage) and pins it to
// the fixture, so the seeded shape cannot drift from what Telegram ingress
// actually assembles.
import { readFileSync } from "node:fs";
import type { Message } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramMessageContextRuntime } from "./bot-handlers.message-context.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { createTelegramPromptContextProjectionCursor } from "./prompt-context-projection.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

// recordOutboundMessageForPromptContext reports persistence failures only as a
// false return plus a verbose log. Capture that log so a failure carries the
// underlying error instead of a bare false.
const verboseLog = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...original,
    logVerbose: (message: string) => {
      verboseLog.lines.push(message);
      original.logVerbose(message);
    },
  };
});

const chatId = 1001;
const botUserId = 900;
let storeCounter = 0;

function inboundTextMessage(messageId: number, text: string, date: number): Message {
  return {
    message_id: messageId,
    date,
    chat: { id: chatId, type: "private" },
    from: { id: 10, is_bot: false, first_name: "Pat" },
    text,
  } as Message;
}

function loadFixture(): unknown {
  const fixtureUrl = new URL("./__fixtures__/telegram-rewind-chat-window.json", import.meta.url);
  return JSON.parse(readFileSync(fixtureUrl, "utf8"));
}

// The window this test pins lives in the message cache's bucket logic; its
// sqlite backing is a core-shard concern (the canonical state store requires
// the host broker, which extension shards do not provide). A Map-backed store
// keeps the persistent-cache code path exercised without that dependency.
function setTelegramInMemoryPluginStateRuntimeForTests(): void {
  const stores = new Map<string, Map<string, unknown>>();
  setTelegramRuntime({
    state: {
      openKeyedStore: (({ namespace }: { namespace: string }) => {
        const entries = stores.get(namespace) ?? new Map<string, unknown>();
        stores.set(namespace, entries);
        return {
          async register(key: string, value: unknown) {
            entries.set(key, value);
          },
          async entries() {
            return Array.from(entries, ([key, value]) => ({ key, value }));
          },
          async delete(key: string) {
            return entries.delete(key);
          },
          async clear() {
            entries.clear();
          },
        };
      }) as unknown as TelegramRuntime["state"]["openKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
}

describe("telegram rewind chat-window fixture", () => {
  beforeEach(() => {
    verboseLog.lines.length = 0;
    resetTelegramMessageCacheForTest();
    setTelegramInMemoryPluginStateRuntimeForTests();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheForTest();
  });

  it("matches the window the real context pipeline assembles", async () => {
    storeCounter += 1;
    const storePath = `/tmp/openclaw-telegram-rewind-window-fixture-${storeCounter}.json`;
    const cfg = { session: { store: storePath } } as const;
    const messageContextRuntime = createTelegramMessageContextRuntime({
      cfg,
      accountId: "default",
      ownerAgentId: "main",
      opts: { token: "test" },
      telegramCfg: {},
      telegramDeps: {
        resolveStorePath: () => storePath,
      } as RegisterTelegramHandlerParams["telegramDeps"],
    });
    await messageContextRuntime.recordMessageForReplyChain(
      inboundTextMessage(101, "retained question", 1),
    );
    await messageContextRuntime.recordMessageForReplyChain(
      inboundTextMessage(102, "discarded question", 2),
    );
    const projection = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-2",
    }).take(true);
    const recordedReply = await recordOutboundMessageForPromptContext({
      cfg,
      account: { accountId: "default", bot: { first_name: "OpenClaw" } },
      chatId,
      message: {
        message_id: 103,
        date: 3,
        chat: { id: chatId, type: "private" },
        from: { id: botUserId, is_bot: true, first_name: "OpenClaw" },
      },
      messageId: 103,
      botUserId,
      text: "discarded reply",
      promptContextProjection: projection,
      ownerAgentId: "main",
    });
    expect(recordedReply, verboseLog.lines.join("\n")).toBe(true);
    const currentMessage = inboundTextMessage(104, "fresh follow-up", 4);
    const telegramCtx = {
      message: currentMessage,
      me: {
        id: botUserId,
        is_bot: true,
        first_name: "OpenClaw",
        username: "openclaw_bot",
      },
      getFile: async () => {
        throw new Error("this test sends no media");
      },
    } as unknown as Parameters<
      ReturnType<typeof createTelegramMessageContextRuntime>["buildPromptContextForMessage"]
    >[0];

    const entries = await messageContextRuntime.buildPromptContextForMessage(
      telegramCtx,
      currentMessage,
      [],
      cfg,
      {},
    );

    // oxlint-disable-next-line unicorn/prefer-structured-clone -- The fixture compares the JSON-stripped shape, not an in-memory clone.
    expect(JSON.parse(JSON.stringify(entries))).toEqual(loadFixture());
  });
});
