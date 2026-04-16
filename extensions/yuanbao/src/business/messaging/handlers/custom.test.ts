/**
 * messaging/handlers/custom.ts 单元测试
 *
 * 测试范围：customHandler 的 extract/buildMsgBody、buildAtUserMsgBodyItem
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MessageHandlerContext } from "../context.js";
import { customHandler, buildAtUserMsgBodyItem } from "./custom/index.js";
import type { ExtractTextFromMsgBodyResult } from "./types.js";

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

void test("customHandler extract 识别 @Bot 消息", () => {
  const ctx = makeMockCtx("bot-001");
  const resData = makeResData();

  const elem = {
    msg_type: "TIMCustomElem",
    msg_content: {
      data: JSON.stringify({ elem_type: 1002, text: "@Bot", user_id: "bot-001" }),
    },
  };

  const result = customHandler.extract(ctx, elem, resData);
  assert.equal(resData.isAtBot, true);
  assert.equal(result, "@Bot"); // @Bot 文本保留（用于 botUsername 提取）
  assert.equal(resData.botUsername, "Bot"); // 提取 bot 显示名称（去除 @ 前缀）
  assert.equal(resData.mentions.length, 1); // @Bot 也记录到 mentions
  assert.equal(resData.mentions[0].userId, "bot-001");
});

void test("customHandler extract 识别 @其他用户 消息", () => {
  const ctx = makeMockCtx("bot-001");
  const resData = makeResData();

  const elem = {
    msg_type: "TIMCustomElem",
    msg_content: {
      data: JSON.stringify({ elem_type: 1002, text: "@张三", user_id: "user-123" }),
    },
  };

  const result = customHandler.extract(ctx, elem, resData);
  assert.equal(resData.isAtBot, false);
  assert.equal(result, "@张三");
  assert.equal(resData.mentions.length, 1);
  assert.equal(resData.mentions[0].userId, "user-123");
});

void test("customHandler extract 非 @ 自定义消息返回 [当前消息暂不支持查看]", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = {
    msg_type: "TIMCustomElem",
    msg_content: {
      data: JSON.stringify({ elem_type: 999, some: "data" }),
    },
  };

  assert.equal(customHandler.extract(ctx, elem, resData), "[当前消息暂不支持查看]");
});

// ============ buildMsgBody ============

void test("customHandler buildMsgBody 构造自定义消息", () => {
  const result = customHandler.buildMsgBody!({ data: JSON.stringify({ key: "value" }) });
  assert.equal(result.length, 1);
  assert.equal(result[0].msg_type, "TIMCustomElem");
  assert.ok(result[0].msg_content.data);
});

void test("customHandler buildMsgBody 接受对象自动序列化", () => {
  const result = customHandler.buildMsgBody!({ data: { key: "value" } });
  assert.equal(result.length, 1);
  const parsed = JSON.parse(result[0].msg_content.data!);
  assert.equal(parsed.key, "value");
});

// ============ buildAtUserMsgBodyItem ============

void test("buildAtUserMsgBodyItem 构造 @ 用户消息体", () => {
  const item = buildAtUserMsgBodyItem("user-123", "张三");
  assert.equal(item.msg_type, "TIMCustomElem");
  const parsed = JSON.parse(item.msg_content.data!);
  assert.equal(parsed.elem_type, 1002);
  assert.equal(parsed.user_id, "user-123");
  assert.equal(parsed.text, "@张三");
});
