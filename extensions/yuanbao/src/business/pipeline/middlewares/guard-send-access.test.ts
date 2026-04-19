/**
 * Unit tests for guard-send-access middleware: send access control (C2C), when guard, rate limit.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";
import { guardSendAccess } from "./guard-send-access.js";

// ============ when condition guard ============

void test("guard-send-access: when guard - executes in C2C", () => {
  const ctx = createMockCtx({ isGroup: false });
  assert.equal(guardSendAccess.when!(ctx), true);
});

void test("guard-send-access: when guard - skips in group chat", () => {
  const ctx = createMockCtx({ isGroup: true });
  assert.equal(guardSendAccess.when!(ctx), false);
});

// ============ Self-send protection ============

void test("guard-send-access: self-send protection - sender = bot -> abort pipeline", async () => {
  const ctx = createMockCtx({
    fromAccount: "bot-001",
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "你好",
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

// ============ Normal pass through ============

void test("guard-send-access: normal user message -> pass through", async () => {
  const ctx = createMockCtx({
    fromAccount: `normal-user-${Date.now()}-1`,
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "你好",
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

// ============ Message length check ============

void test("guard-send-access: message too long -> abort pipeline", async () => {
  const ctx = createMockCtx({
    fromAccount: `len-user-${Date.now()}-2`,
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "x".repeat(4001), // Exceeds default 4000 char limit
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), false, "oversized message should abort pipeline");
});

void test("guard-send-access: message length exactly at limit -> pass through", async () => {
  const ctx = createMockCtx({
    fromAccount: `len-user-${Date.now()}-3`,
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "x".repeat(4000), // Exactly 4000 chars
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

// ============ Rate limit ============

void test("guard-send-access: rate limit - exceeds hourly limit -> abort pipeline", async () => {
  const senderId = `rate-limit-user-${Date.now()}`;

  // Send 60 messages first (default limit)
  for (let i = 0; i < 60; i++) {
    const ctx = createMockCtx({
      fromAccount: senderId,
      account: { botId: "bot-001", accountId: "bot-001" } as any,
      rawBody: `消息 ${i}`,
    });
    const { next } = createMockNext();
    await guardSendAccess.handler(ctx, next);
  }

  // The 61st should be rate-limited
  const ctx = createMockCtx({
    fromAccount: senderId,
    account: { botId: "bot-001", accountId: "bot-001" } as any,
    rawBody: "第61条消息",
  });
  const { next, wasCalled } = createMockNext();

  await guardSendAccess.handler(ctx, next);

  assert.equal(wasCalled(), false, "should abort when rate limit exceeded");
});
