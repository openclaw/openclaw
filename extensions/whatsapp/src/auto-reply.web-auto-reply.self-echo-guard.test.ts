import "./test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { installWebAutoReplyUnitTestHooks, makeSessionStore } from "./auto-reply.test-harness.js";
import { buildMentionConfig } from "./auto-reply/mentions.js";
import { createEchoTracker } from "./auto-reply/monitor/echo.js";
import { createWebOnMessageHandler } from "./auto-reply/monitor/on-message.js";
import { forgetSentMessageId, rememberSentMessageId } from "./send.js";

// Self-echo guard: echo detection for self-chat DMs.
//
// Primary guard (message ID):
//   When sendMessageWhatsApp sends a message, it records the returned Baileys messageId.
//   WhatsApp echoes it back as an inbound event with the same ID → skipped unconditionally.
//
// Fallback guard (responsePrefix):
//   If the ID was not tracked (e.g. ID returned as "unknown"), self-chat messages whose body
//   starts with responsePrefix are treated as self-echoes and dropped.
//
//   Gateway sends "🔥 Quick confirmation..." to WhatsApp
//        │
//        ▼
//   WhatsApp echoes it back as an inbound event
//        │
//        ▼
//   on-message.ts:
//     ID in sent-ID registry?
//       yes → skip (primary guard)          ← Case D
//     responsePrefix set AND body.startsWith(prefix) AND from===selfE164?
//       yes → skip (fallback guard)         ← Case A
//       no  → process normally              ← Cases B, C

function makeCfgWithPrefix(storePath: string, responsePrefix = "🔥 "): OpenClawConfig {
  return {
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
    messages: { responsePrefix },
  };
}

function createHandlerForTest(cfg: OpenClawConfig) {
  const replyResolver = vi.fn().mockResolvedValue(undefined);
  const handler = createWebOnMessageHandler({
    cfg,
    verbose: false,
    connectionId: "test",
    maxMediaBytes: 1024,
    groupHistoryLimit: 3,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: createEchoTracker({ maxItems: 10 }),
    backgroundTasks: new Set(),
    replyResolver: replyResolver as Parameters<
      typeof createWebOnMessageHandler
    >[0]["replyResolver"],
    replyLogger: {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Parameters<typeof createWebOnMessageHandler>[0]["replyLogger"],
    baseMentionConfig: buildMentionConfig(cfg),
    account: {},
  });
  return { handler, replyResolver };
}

function buildMsg(overrides: {
  from: string;
  selfE164: string;
  body: string;
  id?: string;
  chatType?: "direct" | "group";
}) {
  return {
    id: overrides.id ?? "msg1",
    from: overrides.from,
    conversationId: overrides.from,
    to: overrides.selfE164,
    body: overrides.body,
    timestamp: 1_700_000_000,
    chatType: overrides.chatType ?? "direct",
    chatId: overrides.from,
    accountId: "default",
    selfE164: overrides.selfE164,
    sendComposing: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    sendMedia: vi.fn().mockResolvedValue(undefined),
  };
}

describe("self-echo guard (primary message-ID check)", () => {
  installWebAutoReplyUnitTestHooks();

  // Case D: message whose ID was recorded by sendMessageWhatsApp → dropped regardless of body
  it("skips message when its ID was recorded as a recently sent outbound message", async () => {
    const store = await makeSessionStore();
    const cfg = makeCfgWithPrefix(store.storePath);
    const { handler, replyResolver } = createHandlerForTest(cfg);

    const sentId = "3EB09E99673FD8DC2900";
    rememberSentMessageId(sentId);
    try {
      const msg = buildMsg({
        id: sentId,
        from: "+456",
        selfE164: "+123",
        body: "Refined docket for today (ET):",
      });
      await handler(msg);

      expect(replyResolver).not.toHaveBeenCalled();
    } finally {
      forgetSentMessageId(sentId);
      await store.cleanup();
    }
  });

  // Case D2: different user, body has no prefix, but ID not tracked → processed normally
  it("processes message when its ID is not in the sent-ID registry", async () => {
    const store = await makeSessionStore();
    const cfg = makeCfgWithPrefix(store.storePath);
    const { handler, replyResolver } = createHandlerForTest(cfg);

    const msg = buildMsg({ id: "untracked-id", from: "+456", selfE164: "+123", body: "hello" });
    await handler(msg);

    expect(replyResolver).toHaveBeenCalled();
    await store.cleanup();
  });
});

describe("self-echo guard (no false positives on responsePrefix)", () => {
  installWebAutoReplyUnitTestHooks();

  // Case A: self-chat DM whose body starts with responsePrefix but whose ID is not tracked.
  // The prefix-only guard was removed (false-positive risk); only the ID-based guard is
  // authoritative. A real user message starting with the prefix must be processed normally.
  it("processes self-chat message starting with responsePrefix when ID is not tracked", async () => {
    const store = await makeSessionStore();
    const cfg = makeCfgWithPrefix(store.storePath);
    const { handler, replyResolver } = createHandlerForTest(cfg);

    const msg = buildMsg({ from: "+123", selfE164: "+123", body: "🔥 Quick confirmation: done" });
    await handler(msg);

    expect(replyResolver).toHaveBeenCalled();
    await store.cleanup();
  });

  // Case B: self-chat DM where body does NOT start with responsePrefix → processed normally
  it("processes self-chat message when body does not start with responsePrefix", async () => {
    const store = await makeSessionStore();
    const cfg = makeCfgWithPrefix(store.storePath);
    const { handler, replyResolver } = createHandlerForTest(cfg);

    const msg = buildMsg({ from: "+123", selfE164: "+123", body: "hello, what is the weather?" });
    await handler(msg);

    expect(replyResolver).toHaveBeenCalled();
    await store.cleanup();
  });

  // Case C: message from a different user starting with responsePrefix → NOT dropped by self-echo guard
  it("does not skip non-self-chat message starting with responsePrefix", async () => {
    const store = await makeSessionStore();
    const cfg = makeCfgWithPrefix(store.storePath);
    const { handler, replyResolver } = createHandlerForTest(cfg);

    const msg = buildMsg({
      from: "+456",
      selfE164: "+123",
      body: "🔥 hot take from family member",
    });
    await handler(msg);

    expect(replyResolver).toHaveBeenCalled();
    await store.cleanup();
  });
});
