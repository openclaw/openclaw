/**
 * messaging/handlers/index.ts 单元测试
 *
 * 测试范围：getHandler、getAllHandlers、buildMsgBody、prepareOutboundContent、buildOutboundMsgBody
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getHandler,
  getAllHandlers,
  buildMsgBody,
  prepareOutboundContent,
  buildOutboundMsgBody,
} from "./index.js";

// ============ getHandler ============

void test("getHandler 返回已注册的 handler", () => {
  assert.ok(getHandler("TIMTextElem"));
  assert.ok(getHandler("TIMCustomElem"));
  assert.ok(getHandler("TIMImageElem"));
  assert.ok(getHandler("TIMSoundElem"));
  assert.ok(getHandler("TIMFileElem"));
  assert.ok(getHandler("TIMVideoFileElem"));
  assert.ok(getHandler("TIMFaceElem"));
});

void test("getHandler 未注册类型返回 undefined", () => {
  assert.equal(getHandler("TIMUnknownElem"), undefined);
  assert.equal(getHandler(""), undefined);
});

// ============ getAllHandlers ============

void test("getAllHandlers 返回所有已注册 handler", () => {
  const handlers = getAllHandlers();
  assert.ok(handlers.length >= 7, "至少应有 7 种消息类型 handler");

  const types = new Set(handlers.map((h) => h.msgType));
  assert.ok(types.has("TIMTextElem"));
  assert.ok(types.has("TIMCustomElem"));
  assert.ok(types.has("TIMImageElem"));
  assert.ok(types.has("TIMFaceElem"));
});

// ============ buildMsgBody ============

void test("buildMsgBody 通过 msgType 构造消息体", () => {
  const result = buildMsgBody("TIMTextElem", { text: "hello" });
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].msg_type, "TIMTextElem");
  assert.equal(result[0].msg_content.text, "hello");
});

void test("buildMsgBody 未注册类型返回 undefined", () => {
  assert.equal(buildMsgBody("TIMUnknownElem", {}), undefined);
});

// ============ prepareOutboundContent ============

void test("prepareOutboundContent 纯文本", () => {
  const items = prepareOutboundContent("hello world");
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "text");
  assert.equal((items[0] as { type: "text"; text: string }).text, "hello world");
});

void test("prepareOutboundContent 空文本返回空数组", () => {
  assert.deepEqual(prepareOutboundContent(""), []);
  assert.deepEqual(prepareOutboundContent(null as unknown as string), []);
  assert.deepEqual(prepareOutboundContent(undefined as unknown as string), []);
});

// ============ buildOutboundMsgBody ============

void test("buildOutboundMsgBody 将内容项转换为 MsgBody", () => {
  const items = [
    { type: "text" as const, text: "hello" },
    { type: "text" as const, text: "world" },
  ];
  const msgBody = buildOutboundMsgBody(items);
  assert.equal(msgBody.length, 2);
  assert.equal(msgBody[0].msg_type, "TIMTextElem");
  assert.equal(msgBody[0].msg_content.text, "hello");
  assert.equal(msgBody[1].msg_type, "TIMTextElem");
  assert.equal(msgBody[1].msg_content.text, "world");
});

void test("buildOutboundMsgBody 跳过未知类型", () => {
  const items = [
    { type: "text" as const, text: "hello" },
    { type: "unknown" as const, data: "skip me" } as any,
  ];
  const msgBody = buildOutboundMsgBody(items);
  assert.equal(msgBody.length, 1);
  assert.equal(msgBody[0].msg_content.text, "hello");
});
