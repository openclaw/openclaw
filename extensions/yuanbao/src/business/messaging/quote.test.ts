/**
 * messaging/quote.ts 单元测试
 *
 * 测试范围：parseQuoteFromCloudCustomData、formatQuoteContext
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseQuoteFromCloudCustomData, formatQuoteContext } from "./quote.js";

// ============ parseQuoteFromCloudCustomData ============

void test("parseQuoteFromCloudCustomData 解析有效引用", () => {
  const data = JSON.stringify({
    quote: {
      desc: "这是被引用的消息",
      sender_nickname: "张三",
      sender_id: "user-123",
    },
  });

  const result = parseQuoteFromCloudCustomData(data);
  assert.ok(result);
  assert.equal(result.desc, "这是被引用的消息");
  assert.equal(result.sender_nickname, "张三");
  assert.equal(result.sender_id, "user-123");
});

void test("parseQuoteFromCloudCustomData 空输入返回 undefined", () => {
  assert.equal(parseQuoteFromCloudCustomData(undefined), undefined);
  assert.equal(parseQuoteFromCloudCustomData(""), undefined);
});

void test("parseQuoteFromCloudCustomData 无 quote 字段返回 undefined", () => {
  assert.equal(parseQuoteFromCloudCustomData(JSON.stringify({})), undefined);
  assert.equal(parseQuoteFromCloudCustomData(JSON.stringify({ other: "data" })), undefined);
});

void test("parseQuoteFromCloudCustomData 空 desc 返回 undefined", () => {
  const data = JSON.stringify({ quote: { desc: "", sender_id: "user-1" } });
  assert.equal(parseQuoteFromCloudCustomData(data), undefined);

  const data2 = JSON.stringify({ quote: { desc: "   ", sender_id: "user-1" } });
  assert.equal(parseQuoteFromCloudCustomData(data2), undefined);
});

void test("parseQuoteFromCloudCustomData 图片引用使用 [image] 占位符", () => {
  const data = JSON.stringify({
    quote: { type: 2, desc: "", sender_id: "user-1" },
  });
  const result = parseQuoteFromCloudCustomData(data);
  assert.ok(result);
  assert.equal(result.desc, "[image]");
});

void test("parseQuoteFromCloudCustomData 非法 JSON 返回 undefined", () => {
  assert.equal(parseQuoteFromCloudCustomData("{invalid json}"), undefined);
});

// ============ formatQuoteContext ============

void test("formatQuoteContext 格式化引用消息", () => {
  const result = formatQuoteContext({
    desc: "被引用的消息内容",
    sender_nickname: "张三",
  });
  assert.ok(result.includes("[Quoted message from 张三]"));
  assert.ok(result.includes("被引用的消息内容"));
});

void test("formatQuoteContext 使用 sender_id 当 nickname 缺失", () => {
  const result = formatQuoteContext({
    desc: "消息内容",
    sender_id: "user-456",
  });
  assert.ok(result.includes("from user-456"));
});

void test("formatQuoteContext 无发送者信息", () => {
  const result = formatQuoteContext({ desc: "消息内容" });
  assert.ok(result.includes("[Quoted message]"));
  assert.ok(!result.includes("from"));
});

void test("formatQuoteContext 超长引用截断", () => {
  const longDesc = "A".repeat(600);
  const result = formatQuoteContext({ desc: longDesc });
  assert.ok(result.includes("...(truncated)"));
  // 截断后不应包含完整的 600 字符
  assert.ok(result.length < 600);
});
