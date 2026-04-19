/**
 * messaging/handlers/index.ts unit tests.
 *
 * Test scope: getHandler, getAllHandlers, buildMsgBody, prepareOutboundContent, buildOutboundMsgBody
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

void test("getHandler returns registered handler", () => {
  assert.ok(getHandler("TIMTextElem"));
  assert.ok(getHandler("TIMCustomElem"));
  assert.ok(getHandler("TIMImageElem"));
  assert.ok(getHandler("TIMSoundElem"));
  assert.ok(getHandler("TIMFileElem"));
  assert.ok(getHandler("TIMVideoFileElem"));
  assert.ok(getHandler("TIMFaceElem"));
});

void test("getHandler returns undefined for unregistered type", () => {
  assert.equal(getHandler("TIMUnknownElem"), undefined);
  assert.equal(getHandler(""), undefined);
});

// ============ getAllHandlers ============

void test("getAllHandlers returns all registered handlers", () => {
  const handlers = getAllHandlers();
  assert.ok(handlers.length >= 7, "should have at least 7 message type handlers");

  const types = new Set(handlers.map((h) => h.msgType));
  assert.ok(types.has("TIMTextElem"));
  assert.ok(types.has("TIMCustomElem"));
  assert.ok(types.has("TIMImageElem"));
  assert.ok(types.has("TIMFaceElem"));
});

// ============ buildMsgBody ============

void test("buildMsgBody constructs message body by msgType", () => {
  const result = buildMsgBody("TIMTextElem", { text: "hello" });
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].msg_type, "TIMTextElem");
  assert.equal(result[0].msg_content.text, "hello");
});

void test("buildMsgBody returns undefined for unregistered type", () => {
  assert.equal(buildMsgBody("TIMUnknownElem", {}), undefined);
});

// ============ prepareOutboundContent ============

void test("prepareOutboundContent plain text", () => {
  const items = prepareOutboundContent("hello world");
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "text");
  assert.equal((items[0] as { type: "text"; text: string }).text, "hello world");
});

void test("prepareOutboundContent empty text returns empty array", () => {
  assert.deepEqual(prepareOutboundContent(""), []);
  assert.deepEqual(prepareOutboundContent(null as unknown as string), []);
  assert.deepEqual(prepareOutboundContent(undefined as unknown as string), []);
});

// ============ buildOutboundMsgBody ============

void test("buildOutboundMsgBody converts content items to MsgBody", () => {
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

void test("buildOutboundMsgBody skips unknown types", () => {
  const items = [
    { type: "text" as const, text: "hello" },
    { type: "unknown" as const, data: "skip me" } as any,
  ];
  const msgBody = buildOutboundMsgBody(items);
  assert.equal(msgBody.length, 1);
  assert.equal(msgBody[0].msg_content.text, "hello");
});
