/**
 * 中间件 rewrite-body 单元测试
 *
 * 测试范围：斜杠命令改写、引用拼接、mentions 拼接
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 公共 mock 设置 ============

/** 注册 rewrite-body 所需的模块 mock */
function setupMocks(t: any, formatQuoteImpl?: (q: any) => string) {
  t.mock.module("../../messaging/quote.js", {
    namedExports: {
      formatQuoteContext:
        formatQuoteImpl ??
        ((q: any) => `> [Quoted message from ${q.sender_nickname ?? "unknown"}]:\n>${q.desc}\n`),
    },
  });
}

// ============ handler 逻辑 ============

void test("rewrite-body: 普通文本不改写", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({ rawBody: "你好", mentions: [] });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.equal(ctx.rewrittenBody, "你好");
});

void test("rewrite-body: /yuanbao-health-check 带时间参数改写", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({ rawBody: "/yuanbao-health-check 09:00 10:00", mentions: [] });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(ctx.rewrittenBody.includes("从09:00到10:00"), "应包含时间段");
  assert.ok(ctx.rewrittenBody.includes("warn"), "应包含 warn 关键词");
  assert.ok(ctx.rewrittenBody.includes("error"), "应包含 error 关键词");
});

void test("rewrite-body: /yuanbao-health-check 无时间参数 → 默认过去10分钟", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({ rawBody: "/yuanbao-health-check", mentions: [] });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(ctx.rewrittenBody.includes("过去10分钟"), "应包含默认时间段");
});

void test("rewrite-body: 引用消息拼接", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({
    rawBody: "这是什么意思",
    quoteInfo: { id: "msg-1", desc: "被引用的内容", sender_nickname: "张三" } as any,
    mentions: [],
  });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(ctx.rewrittenBody.includes("被引用的内容"), "应包含引用内容");
  assert.ok(ctx.rewrittenBody.includes("张三"), "应包含引用发送者");
  assert.ok(ctx.rewrittenBody.includes("这是什么意思"), "应包含原始消息");
});

void test("rewrite-body: 群聊 mentions 拼接", async (t) => {
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

  assert.ok(ctx.rewrittenBody.includes("@张三"), "应包含 @张三");
  assert.ok(ctx.rewrittenBody.includes("@李四"), "应包含 @李四");
  assert.ok(ctx.rewrittenBody.includes("user-002"), "应包含 userId");
});

void test("rewrite-body: C2C 场景不拼接 mentions", async (t) => {
  setupMocks(t);
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({
    rawBody: "帮我看看",
    isGroup: false,
    mentions: [{ text: "@张三", userId: "user-002" }] as any,
  });
  const { next } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.ok(!ctx.rewrittenBody.includes("@张三"), "C2C 不应拼接 mentions");
});

void test("rewrite-body: 引用 + mentions 同时存在", async (t) => {
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

  assert.ok(ctx.rewrittenBody.includes("引用内容"), "应包含引用");
  assert.ok(ctx.rewrittenBody.includes("@赵六"), "应包含 mentions");
  assert.ok(ctx.rewrittenBody.includes("这个怎么理解"), "应包含原始消息");
});

void test("rewrite-body: 调用 next 继续管线", async (t) => {
  setupMocks(t, () => "");
  const { rewriteBody } = await import("./rewrite-body.js");

  const ctx = createMockCtx({ rawBody: "test", mentions: [] });
  const { next, wasCalled } = createMockNext();

  await rewriteBody.handler(ctx, next);

  assert.equal(wasCalled(), true);
});
