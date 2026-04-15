/**
 * 中间件 guard-send-access 单元测试
 *
 * 测试范围：发送访问控制守卫（C2C）、when 条件守卫、频率限制
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";
import { guardSendAccess } from "./guard-send-access.js";

// ============ when 条件守卫 ============

void test("guard-send-access: when 条件 - C2C 时执行", () => {
  const ctx = createMockCtx({ isGroup: false });
  assert.equal(guardSendAccess.when!(ctx), true);
});

void test("guard-send-access: when 条件 - 群聊时跳过", () => {
  const ctx = createMockCtx({ isGroup: true });
  assert.equal(guardSendAccess.when!(ctx), false);
});

// ============ 自发防护 ============

void test("guard-send-access: 自发防护 - 发送者 = 机器人 → 终止管线", async () => {
  const ctx = createMockCtx({
    fromAccount: "bot-001",
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "你好",
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

// ============ 正常放行 ============

void test("guard-send-access: 正常用户消息 → 放行", async () => {
  const ctx = createMockCtx({
    fromAccount: `normal-user-${Date.now()}-1`,
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "你好",
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

// ============ 消息长度检查 ============

void test("guard-send-access: 消息过长 → 终止管线", async () => {
  const ctx = createMockCtx({
    fromAccount: `len-user-${Date.now()}-2`,
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "x".repeat(4001), // 超过默认 4000 字符限制
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), false, "超长消息应终止管线");
});

void test("guard-send-access: 消息长度刚好在限制内 → 放行", async () => {
  const ctx = createMockCtx({
    fromAccount: `len-user-${Date.now()}-3`,
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "x".repeat(4000), // 刚好 4000 字符
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

// ============ 频率限制 ============

void test("guard-send-access: 频率限制 - 超过每小时限制 → 终止管线", async () => {
  const senderId = `rate-limit-user-${Date.now()}`;

  // 先发送 60 条消息（默认限制）
  for (let i = 0; i < 60; i++) {
    const ctx = createMockCtx({
      fromAccount: senderId,
      account: { botId: "bot-001", accountId: "bot-001" } as any,
      rawBody: `消息 ${i}`,
    });
    const { next } = createMockNext();
    await guardSendAccess.handler(ctx, next);
  }

  // 第 61 条应被限制
  const ctx = createMockCtx({
    fromAccount: senderId,
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "第61条消息",
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), false, "超过频率限制应终止管线");
});
