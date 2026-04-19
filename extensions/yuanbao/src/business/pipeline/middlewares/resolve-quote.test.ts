/**
 * Unit tests for resolve-quote middleware: quote message parsing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ Shared mutable mock state ============

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

void test("resolve-quote: populates ctx.quoteInfo when quote exists", async (t) => {
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

void test("resolve-quote: quoteInfo stays undefined when no quote", async (t) => {
  setupMocks(t, undefined);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({});
  const { next, wasCalled } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(ctx.quoteInfo, undefined);
  assert.equal(wasCalled(), true);
});

void test("resolve-quote: empty cloud_custom_data passes through", async (t) => {
  setupMocks(t, undefined);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    raw: { cloud_custom_data: undefined } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(wasCalled(), true);
});
