/**
 * utils.ts 单元测试
 *
 * 测试范围：textDesensitization、msgBodyDesensitization
 */

import assert from "node:assert/strict";
import test from "node:test";
import { textDesensitization, msgBodyDesensitization } from "./utils.js";

// ============ textDesensitization ============

void test("textDesensitization 短文本不脱敏", () => {
  assert.equal(textDesensitization("你好世界"), "你好世界");
  assert.equal(textDesensitization("hello"), "hello");
  assert.equal(textDesensitization("ab"), "ab");
});

void test("textDesensitization 长文本脱敏", () => {
  // 长度 > 5 时，保留首尾各 2 字符
  const result = textDesensitization("这是一段测试文本");
  assert.equal(result, "这是***(4)***文本");

  const result2 = textDesensitization("abcdefgh");
  assert.equal(result2, "ab***(4)***gh");
});

void test("textDesensitization 边界长度（6 字符）", () => {
  const result = textDesensitization("abcdef");
  assert.equal(result, "ab***(2)***ef");
});

// ============ msgBodyDesensitization ============

void test("msgBodyDesensitization 处理文本消息", () => {
  const result = msgBodyDesensitization([
    { msg_type: "TIMTextElem", msg_content: { text: "这是一段测试文本" } },
  ]);
  assert.equal(result, "[text:这是***(4)***文本]");
});

void test("msgBodyDesensitization 处理非文本消息", () => {
  const result = msgBodyDesensitization([
    { msg_type: "TIMImageElem", msg_content: { url: "https://example.com/img.png" } },
  ]);
  assert.equal(result, '[TIMImageElem:{"url":"https://example.com/img.png"}]');
});

void test("msgBodyDesensitization 处理混合消息", () => {
  const result = msgBodyDesensitization([
    { msg_type: "TIMTextElem", msg_content: { text: "hello" } },
    { msg_type: "TIMImageElem", msg_content: { url: "https://img.com/a.png" } },
  ]);
  assert.equal(result, '[text:hello][TIMImageElem:{"url":"https://img.com/a.png"}]');
});
