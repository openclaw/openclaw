/**
 * 中间件 skip-placeholder 单元测试
 *
 * 测试范围：占位符消息、空消息跳过逻辑
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";
import { skipPlaceholder } from "./skip-placeholder.js";

// ============ C2C 场景 ============

void test("skip-placeholder(C2C): 空消息 → 终止管线", async () => {
  const ctx = createMockCtx({ rawBody: "", isGroup: false });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("skip-placeholder(C2C): 纯空白消息 → 终止管线", async () => {
  const ctx = createMockCtx({ rawBody: "   \n\t  ", isGroup: false });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("skip-placeholder(C2C): 正常文本 → 放行", async () => {
  const ctx = createMockCtx({ rawBody: "你好", isGroup: false });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

// ============ 群聊场景 ============

void test("skip-placeholder(群聊): 空消息 + 无媒体 + 非@bot → 终止管线", async () => {
  const ctx = createMockCtx({
    rawBody: "",
    isGroup: true,
    medias: [],
    isAtBot: false,
  });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("skip-placeholder(群聊): 空消息 + 有媒体 → 放行", async () => {
  const ctx = createMockCtx({
    rawBody: "",
    isGroup: true,
    medias: [{ mediaType: "image", url: "https://example.com/img.jpg" }] as any,
    isAtBot: false,
  });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("skip-placeholder(群聊): 空消息 + @bot → 放行", async () => {
  const ctx = createMockCtx({
    rawBody: "",
    isGroup: true,
    medias: [],
    isAtBot: true,
  });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

// ============ 占位符消息 ============

void test("skip-placeholder: [image] 占位符 + 无媒体 → 终止管线", async () => {
  const ctx = createMockCtx({ rawBody: "[image]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("skip-placeholder: [file] 占位符 + 无媒体 → 终止管线", async () => {
  const ctx = createMockCtx({ rawBody: "[file]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("skip-placeholder: [image] 占位符 + 有媒体 → 放行", async () => {
  const ctx = createMockCtx({
    rawBody: "[image]",
    medias: [{ mediaType: "image", url: "https://example.com/img.jpg" }] as any,
  });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("skip-placeholder: [EMOJI] 不视为占位符 → 放行", async () => {
  const ctx = createMockCtx({ rawBody: "[EMOJI]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("skip-placeholder: [EMOJI: smile] 不视为占位符 → 放行", async () => {
  const ctx = createMockCtx({ rawBody: "[EMOJI: smile]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("skip-placeholder: 多行文本不是占位符 → 放行", async () => {
  const ctx = createMockCtx({ rawBody: "你好\n[image]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});
