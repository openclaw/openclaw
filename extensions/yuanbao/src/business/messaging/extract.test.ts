/**
 * messaging/extract.ts 单元测试
 *
 * 测试范围：extractTextFromMsgBody 集成测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MessageHandlerContext } from "./context.js";
import { extractTextFromMsgBody } from "./extract.js";

function makeMockCtx(botId = "bot-001"): MessageHandlerContext {
  return {
    account: { botId },
    config: {},
    core: {},
    log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
    wsClient: {},
  } as unknown as MessageHandlerContext;
}

void test("extractTextFromMsgBody 处理混合消息体", () => {
  const ctx = makeMockCtx("bot-001");
  const result = extractTextFromMsgBody(ctx, [
    { msg_type: "TIMTextElem", msg_content: { text: "hello" } },
    {
      msg_type: "TIMImageElem",
      msg_content: {
        image_info_array: [
          { type: 1, url: "https://example.com/img.png" },
          { type: 2, url: "https://example.com/medium.png" },
        ],
      },
    },
    { msg_type: "TIMTextElem", msg_content: { text: "world" } },
  ]);

  assert.ok(result.rawBody.includes("hello"));
  assert.ok(result.rawBody.includes("world"));
  assert.ok(result.rawBody.includes("[image1]"));
  assert.equal(result.medias.length, 1);
  assert.equal(result.medias[0].url, "https://example.com/medium.png");
});

void test("extractTextFromMsgBody 处理 @Bot 消息", () => {
  const ctx = makeMockCtx("bot-001");
  const result = extractTextFromMsgBody(ctx, [
    {
      msg_type: "TIMCustomElem",
      msg_content: {
        data: JSON.stringify({ elem_type: 1002, text: "@Bot", user_id: "bot-001" }),
      },
    },
    { msg_type: "TIMTextElem", msg_content: { text: "请帮我查一下" } },
  ]);

  assert.equal(result.isAtBot, true);
  assert.ok(result.rawBody.includes("请帮我查一下"));
});

void test("extractTextFromMsgBody 空输入返回默认结果", () => {
  const ctx = makeMockCtx();

  const result1 = extractTextFromMsgBody(ctx, undefined);
  assert.equal(result1.rawBody, "");
  assert.equal(result1.isAtBot, false);
  assert.equal(result1.medias.length, 0);

  const result2 = extractTextFromMsgBody(ctx, []);
  assert.equal(result2.rawBody, "");

  const result3 = extractTextFromMsgBody(ctx, null as any);
  assert.equal(result3.rawBody, "");
});

void test("extractTextFromMsgBody 忽略未注册的消息类型", () => {
  const ctx = makeMockCtx();
  const result = extractTextFromMsgBody(ctx, [
    { msg_type: "TIMUnknownElem", msg_content: { data: "unknown" } },
    { msg_type: "TIMTextElem", msg_content: { text: "visible" } },
  ]);

  assert.equal(result.rawBody, "visible");
});
