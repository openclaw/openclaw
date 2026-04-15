/**
 * 中间件 resolve-quote 单元测试
 *
 * 测试范围：引用消息解析
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

let mockQuoteResult: any = undefined;

let mockRegistered = false;

function setupMocks(t: any, quoteResult?: any) {
  mockQuoteResult = quoteResult;
  if (!mockRegistered) {
    t.mock.module("../../messaging/quote.js", {
      namedExports: {
        parseQuoteFromCloudCustomData: () => mockQuoteResult,
        formatQuoteContext: () => "",
      },
    });
    mockRegistered = true;
  }
}

void test("resolve-quote: 有引用消息时填充 ctx.quoteInfo", async (t) => {
  const mockQuote = { id: "msg-ref-1", desc: "被引用的内容", sender_nickname: "张三" };
  setupMocks(t, mockQuote);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    raw: { cloud_custom_data: '{"quote":{}}' } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.deepEqual(ctx.quoteInfo, mockQuote);
  assert.equal(wasCalled(), true);
});

void test("resolve-quote: 无引用消息时 quoteInfo 保持 undefined", async (t) => {
  setupMocks(t, undefined);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({});
  const { next, wasCalled } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(ctx.quoteInfo, undefined);
  assert.equal(wasCalled(), true);
});

void test("resolve-quote: cloud_custom_data 为空时正常放行", async (t) => {
  setupMocks(t, undefined);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    raw: { cloud_custom_data: undefined } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(wasCalled(), true);
});
