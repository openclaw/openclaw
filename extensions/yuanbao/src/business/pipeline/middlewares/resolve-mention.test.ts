/**
 * Unit tests for resolve-mention middleware: @detection guard and when condition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ Shared mutable mock state ============

let mockGatingResult = { effectiveWasMentioned: false, shouldSkip: false };

let mockRegistered = false;

function setupMocks(
  t: any,
  overrides?: {
    gatingResult?: { effectiveWasMentioned: boolean; shouldSkip: boolean };
  },
) {
  mockGatingResult = overrides?.gatingResult ?? { effectiveWasMentioned: false, shouldSkip: false };
  if (!mockRegistered) {
    t.mock.module("openclaw/plugin-sdk/channel-inbound", {
      namedExports: {
        resolveMentionGatingWithBypass: () => ({ ...mockGatingResult }),
        logInboundDrop: () => {},
      },
    });
    t.mock.module("openclaw/plugin-sdk/reply-history", {
      namedExports: { recordPendingHistoryEntryIfEnabled: () => {} },
    });
    t.mock.module("../../messaging/chat-history.js", {
      namedExports: {
        chatHistories: new Map(),
        recordMediaHistory: () => {},
      },
    });
    mockRegistered = true;
  }
}

// ============ when condition guard ============

void test("resolve-mention: when guard - executes in group chat", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({ isGroup: true });
  assert.equal(resolveMention.when!(ctx), true);
});

void test("resolve-mention: when guard - skips in C2C", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({ isGroup: false });
  assert.equal(resolveMention.when!(ctx), false);
});

// ============ Handler logic ============

void test("resolve-mention: @bot message -> pass through", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: true, shouldSkip: false },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: true,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      requireMention: true,
      historyLimit: 10,
    } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
      },
    } as any,
    config: {} as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(ctx.effectiveWasMentioned, true);
  assert.equal(wasCalled(), true);
});

void test("resolve-mention: non-@bot message -> abort pipeline", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: true },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-001" as any,
    rawBody: "normal group message",
    fromAccount: "user-001",
    medias: [],
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      requireMention: true,
      historyLimit: 10,
    } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
      },
    } as any,
    config: {} as any,
    raw: { msg_id: "msg-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false, "non-@bot should abort pipeline");
});

void test("resolve-mention: command bypasses @detection -> pass through", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: false },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    hasControlCommand: true,
    commandAuthorized: true,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      requireMention: true,
      historyLimit: 0,
    } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
      },
    } as any,
    config: {} as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), true, "command should bypass @detection");
});
