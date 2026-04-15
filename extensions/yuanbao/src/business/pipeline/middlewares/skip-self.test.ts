/**
 * 中间件 skip-self 单元测试
 *
 * 测试范围：机器人自身消息跳过逻辑
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";
import { skipSelf } from "./skip-self.js";

void test("skip-self: 机器人自身消息 → 终止管线", async () => {
  const ctx = createMockCtx({
    fromAccount: "bot-001",
    account: { botId: "bot-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await skipSelf.handler(ctx, next);

  assert.equal(wasCalled(), false, "不应调用 next");
});

void test("skip-self: 非机器人消息 → 放行", async () => {
  const ctx = createMockCtx({
    fromAccount: "user-001",
    account: { botId: "bot-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await skipSelf.handler(ctx, next);

  assert.equal(wasCalled(), true, "应调用 next");
});

void test("skip-self: fromAccount 与 botId 大小写不同 → 放行", async () => {
  const ctx = createMockCtx({
    fromAccount: "Bot-001",
    account: { botId: "bot-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await skipSelf.handler(ctx, next);

  assert.equal(wasCalled(), true, "大小写不同应放行");
});
