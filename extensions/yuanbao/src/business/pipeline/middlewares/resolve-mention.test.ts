/**
 * 中间件 resolve-mention 单元测试
 *
 * 测试范围：@检测守卫（群聊）、when 条件守卫
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

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

// ============ when 条件守卫 ============

void test("resolve-mention: when 条件 - 群聊时执行", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({ isGroup: true });
  assert.equal(resolveMention.when!(ctx), true);
});

void test("resolve-mention: when 条件 - C2C 时跳过", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({ isGroup: false });
  assert.equal(resolveMention.when!(ctx), false);
});

// ============ handler 逻辑 ============

void test("resolve-mention: @bot 消息 → 放行", async (t) => {
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

void test("resolve-mention: 非 @bot 消息 → 终止管线", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: true },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-001" as any,
    rawBody: "普通群消息",
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

  assert.equal(wasCalled(), false, "非 @bot 应终止管线");
});

void test("resolve-mention: 命令绕过 @检测 → 放行", async (t) => {
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

  assert.equal(wasCalled(), true, "命令应绕过 @检测");
});
