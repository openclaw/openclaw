/**
 * Unit tests for skip-placeholder middleware: placeholder and empty message skip logic.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";
import { skipPlaceholder } from "./skip-placeholder.js";

void test("skip-placeholder(C2C): empty message -> abort pipeline", async () => {
  const ctx = createMockCtx({ rawBody: "", isGroup: false });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("skip-placeholder(C2C): whitespace-only message -> abort pipeline", async () => {
  const ctx = createMockCtx({ rawBody: "   \n\t  ", isGroup: false });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("skip-placeholder(C2C): normal text -> pass through", async () => {
  const ctx = createMockCtx({ rawBody: "你好", isGroup: false });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("skip-placeholder(group): empty + no media + not @bot -> abort pipeline", async () => {
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

void test("skip-placeholder(group): empty + has media -> pass through", async () => {
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

void test("skip-placeholder(group): empty + @bot -> pass through", async () => {
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

void test("skip-placeholder: [image] placeholder + no media -> abort pipeline", async () => {
  const ctx = createMockCtx({ rawBody: "[image]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("skip-placeholder: [file] placeholder + no media -> abort pipeline", async () => {
  const ctx = createMockCtx({ rawBody: "[file]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("skip-placeholder: [image] placeholder + has media -> pass through", async () => {
  const ctx = createMockCtx({
    rawBody: "[image]",
    medias: [{ mediaType: "image", url: "https://example.com/img.jpg" }] as any,
  });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("skip-placeholder: [EMOJI] not a placeholder -> pass through", async () => {
  const ctx = createMockCtx({ rawBody: "[EMOJI]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("skip-placeholder: [EMOJI: smile] not a placeholder -> pass through", async () => {
  const ctx = createMockCtx({ rawBody: "[EMOJI: smile]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("skip-placeholder: multi-line text is not a placeholder -> pass through", async () => {
  const ctx = createMockCtx({ rawBody: "你好\n[image]", medias: [] });
  const { next, wasCalled } = createMockNext();

  await skipPlaceholder.handler(ctx, next);

  assert.equal(wasCalled(), true);
});
