/**
 * Unit tests for skip-self middleware: bot self-message skip logic.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";
import { skipSelf } from "./skip-self.js";

void test("skip-self: bot's own message -> abort pipeline", async () => {
  const ctx = createMockCtx({
    fromAccount: "bot-001",
    account: { botId: "bot-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await skipSelf.handler(ctx, next);

  assert.equal(wasCalled(), false, "should not call next");
});

void test("skip-self: non-bot message -> pass through", async () => {
  const ctx = createMockCtx({
    fromAccount: "user-001",
    account: { botId: "bot-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await skipSelf.handler(ctx, next);

  assert.equal(wasCalled(), true, "should call next");
});

void test("skip-self: fromAccount differs from botId in case -> pass through", async () => {
  const ctx = createMockCtx({
    fromAccount: "Bot-001",
    account: { botId: "bot-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await skipSelf.handler(ctx, next);

  assert.equal(wasCalled(), true, "different case should pass through");
});
