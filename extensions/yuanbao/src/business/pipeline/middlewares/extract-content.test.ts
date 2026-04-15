/**
 * 中间件 extract-content 单元测试
 *
 * 测试范围：消息内容提取
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

/** 可变的 extractTextFromMsgBody 返回值，每个测试可重新配置 */
let mockExtractResult = {
  rawBody: "",
  isAtBot: false,
  medias: [] as any[],
  mentions: [] as any[],
};

// 仅在第一个测试中注册 mock（后续测试复用同一 mock 实例）
let mockRegistered = false;

function setupMocks(
  t: any,
  extractResult?: {
    rawBody?: string;
    isAtBot?: boolean;
    medias?: any[];
    mentions?: any[];
  },
) {
  mockExtractResult = {
    rawBody: extractResult?.rawBody ?? "",
    isAtBot: extractResult?.isAtBot ?? false,
    medias: extractResult?.medias ?? [],
    mentions: extractResult?.mentions ?? [],
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

// ============ handler 逻辑 ============

void test("extract-content: 提取 fromAccount 和 senderNickname", async (t) => {
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

void test("extract-content: 群聊场景提取 groupCode", async (t) => {
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

void test("extract-content: C2C 场景 private_from_group_code 填充 groupCode", async (t) => {
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

void test("extract-content: fromAccount 为空时默认 unknown", async (t) => {
  setupMocks(t);
  const { extractContent } = await import("./extract-content.js");

  const ctx = createMockCtx({
    raw: { from_account: "", msg_body: [] } as any,
  });
  const { next } = createMockNext();

  await extractContent.handler(ctx, next);

  assert.equal(ctx.fromAccount, "unknown");
});

void test("extract-content: 调用 next 继续管线", async (t) => {
  setupMocks(t, { rawBody: "test" });
  const { extractContent } = await import("./extract-content.js");

  const ctx = createMockCtx({
    raw: { from_account: "user-001", msg_body: [] } as any,
  });
  const { next, wasCalled } = createMockNext();

  await extractContent.handler(ctx, next);

  assert.equal(wasCalled(), true);
});
