/**
 * Unit tests for rewrite-body middleware: slash command rewrite, quote concat, mentions concat.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ Shared mock setup ============

/** Register module mocks required by rewrite-body */
function setupMocks(t: any, formatQuoteImpl?: (q: any) => string) {
  t.mock.module("../../messaging/quote.js", {
    namedExports: {
      formatQuoteContext:
        formatQuoteImpl ??
        ((q: any) => `> [Quoted message from ${q.sender_nickname ?? "unknown"}]:\n>${q.desc}\n`),
    },
  });
}

// ============ Handler logic ============

void test("rewrite-body: plain text is not rewritten", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({ rawBody: "你好", mentions: [] });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.equal(ctx.rewrittenBody, "你好");
});

void test("rewrite-body: /yuanbao-health-check with time params is rewritten", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({ rawBody: "/yuanbao-health-check 09:00 10:00", mentions: [] });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(ctx.rewrittenBody.includes("from 09:00 to 10:00"), "should contain time range");
  assert.ok(ctx.rewrittenBody.includes("warn"), "should contain warn keyword");
  assert.ok(ctx.rewrittenBody.includes("error"), "should contain error keyword");
});

void test("rewrite-body: /yuanbao-health-check without time params -> default last 10 minutes", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({ rawBody: "/yuanbao-health-check", mentions: [] });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(ctx.rewrittenBody.includes("last 10 minutes"), "should contain default time range");
});

void test("rewrite-body: quote message concat", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({
    rawBody: "这是什么意思",
    quoteInfo: { id: "msg-1", desc: "被引用的内容", sender_nickname: "张三" } as any,
    mentions: [],
  });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(ctx.rewrittenBody.includes("被引用的内容"), "should contain quoted content");
  assert.ok(ctx.rewrittenBody.includes("张三"), "should contain quote sender");
  assert.ok(ctx.rewrittenBody.includes("这是什么意思"), "should contain original message");
});

void test("rewrite-body: group chat mentions concat", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({
    rawBody: "帮我看看",
    isGroup: true,
    mentions: [
      { text: "@张三", userId: "user-002" },
      { text: "@李四", userId: "user-003" },
    ] as any,
  });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(ctx.rewrittenBody.includes("@张三"), "should contain @张三");
  assert.ok(ctx.rewrittenBody.includes("@李四"), "should contain @李四");
  assert.ok(ctx.rewrittenBody.includes("user-002"), "should contain userId");
});

void test("rewrite-body: C2C does not concat mentions", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({
    rawBody: "帮我看看",
    isGroup: false,
    mentions: [{ text: "@张三", userId: "user-002" }] as any,
  });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(!ctx.rewrittenBody.includes("@张三"), "C2C should not concat mentions");
});

void test("rewrite-body: quote + mentions both present", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({
    rawBody: "这个怎么理解",
    isGroup: true,
    quoteInfo: { id: "msg-1", desc: "引用内容", sender_nickname: "王五" } as any,
    mentions: [{ text: "@赵六", userId: "user-004" }] as any,
  });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(ctx.rewrittenBody.includes("引用内容"), "should contain quote");
  assert.ok(ctx.rewrittenBody.includes("@赵六"), "should contain mentions");
  assert.ok(ctx.rewrittenBody.includes("这个怎么理解"), "should contain original message");
});

void test("rewrite-body: calls next to continue pipeline", async (t) => {
  setupMocks(t, () => "");
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({ rawBody: "test", mentions: [] });
  const { next, wasCalled } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.equal(wasCalled(), true);
});
