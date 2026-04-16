/**
 * messaging/handlers/text.ts 单元测试
 *
 * 测试范围：textHandler 的 extract 和 buildMsgBody
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MessageHandlerContext } from "../context.js";
import { textHandler } from "./text.js";
import type { ExtractTextFromMsgBodyResult } from "./types.js";

// 构造最小的 mock 上下文
function makeMockCtx(botId = "bot-001"): MessageHandlerContext {
  return {
    account: { botId },
    config: {},
    core: {},
    log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
    wsClient: {},
  } as unknown as MessageHandlerContext;
}

function makeResData(): ExtractTextFromMsgBodyResult {
  return { rawBody: "", isAtBot: false, medias: [], mentions: [], linkUrls: [] };
}

// ============ extract ============

void test("textHandler extract 提取文本", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const result = textHandler.extract(
    ctx,
    { msg_type: "TIMTextElem", msg_content: { text: "hello world" } },
    resData,
  );
  assert.equal(result, "hello world");
});

void test("textHandler extract 空文本返回 undefined", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  assert.equal(
    textHandler.extract(ctx, { msg_type: "TIMTextElem", msg_content: { text: "" } }, resData),
    undefined,
  );
  assert.equal(
    textHandler.extract(ctx, { msg_type: "TIMTextElem", msg_content: {} }, resData),
    undefined,
  );
});

// ============ buildMsgBody ============

void test("textHandler buildMsgBody 构造文本消息", () => {
  const result = textHandler.buildMsgBody!({ text: "test message" });
  assert.equal(result.length, 1);
  assert.equal(result[0].msg_type, "TIMTextElem");
  assert.equal(result[0].msg_content.text, "test message");
});
