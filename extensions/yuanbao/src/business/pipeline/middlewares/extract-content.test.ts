/**
 * Unit tests for extract-content middleware: message content extraction.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ Shared mutable mock state ============

/** Mutable extractTextFromMsgBody return value, reconfigurable per test */
let mockExtractResult = {
  rawBody: "",
  isAtBot: false,
  medias: [] as any[],
  mentions: [] as any[],
  linkUrls: [] as string[],
};

// Register mock only in the first test (subsequent tests reuse the same mock instance)
let mockRegistered = false;

function setupMocks(
  t: any,
  extractResult?: {
    rawBody?: string;
    isAtBot?: boolean;
    medias?: any[];
    mentions?: any[];
    linkUrls?: string[];
  },
) {
  mockExtractResult = {
    rawBody: extractResult?.rawBody ?? "",
    isAtBot: extractResult?.isAtBot ?? false,
    medias: extractResult?.medias ?? [],
    mentions: extractResult?.mentions ?? [],
    linkUrls: extractResult?.linkUrls ?? [],
  };
  if (!mockRegistered) {
    t.mock.module("../../messaging/extract.js", {
      namedExports: {
        extractTextFromMsgBody: () => ({ ...mockExtractResult }),
      },
    });
    mockRegistered = true;
  }
}

// ============ Handler logic ============

void test("extract-content: extracts fromAccount and senderNickname", async (t) => {
  setupMocks(t, { rawBody: "你好" });
  const { extractContent } = await import("./extract-content.js");

  const ctx = createMockCtx({
    raw: { from_account: "  user-002  ", sender_nickname: "  张三  ", msg_body: [] } as any,
  });
  const { next } = createMockNext();

  await extractContent.handler(ctx, next);

  assert.equal(ctx.fromAccount, "user-002");
  assert.equal(ctx.senderNickname, "张三");
});

void test("extract-content: group chat extracts groupCode", async (t) => {
  setupMocks(t, {
    rawBody: "群消息",
    isAtBot: true,
    mentions: [{ text: "@bot", userId: "bot-001" }],
  });
  const { extractContent } = await import("./extract-content.js");

  const ctx = createMockCtx({
    isGroup: true,
    raw: { from_account: "user-001", group_code: "group-001", msg_body: [] } as any,
  });
  const { next } = createMockNext();

  await extractContent.handler(ctx, next);

  assert.equal(ctx.groupCode, "group-001");
  assert.equal(ctx.rawBody, "群消息");
  assert.equal(ctx.isAtBot, true);
});

void test("extract-content: C2C private_from_group_code populates groupCode", async (t) => {
  setupMocks(t, { rawBody: "私聊消息" });
  const { extractContent } = await import("./extract-content.js");

  const ctx = createMockCtx({
    isGroup: false,
    raw: { from_account: "user-001", private_from_group_code: "group-002", msg_body: [] } as any,
  });
  const { next } = createMockNext();

  await extractContent.handler(ctx, next);

  assert.equal(ctx.groupCode, "group-002");
});

void test("extract-content: fromAccount defaults to unknown when empty", async (t) => {
  setupMocks(t);
  const { extractContent } = await import("./extract-content.js");

  const ctx = createMockCtx({
    raw: { from_account: "", msg_body: [] } as any,
  });
  const { next } = createMockNext();

  await extractContent.handler(ctx, next);

  assert.equal(ctx.fromAccount, "unknown");
});

void test("extract-content: calls next to continue pipeline", async (t) => {
  setupMocks(t, { rawBody: "test" });
  const { extractContent } = await import("./extract-content.js");

  const ctx = createMockCtx({
    raw: { from_account: "user-001", msg_body: [] } as any,
  });
  const { next, wasCalled } = createMockNext();

  await extractContent.handler(ctx, next);

  assert.equal(wasCalled(), true);
});
