/**
 * 中间件 guard-group-command 单元测试
 *
 * 测试范围：群命令白名单守卫、when 条件守卫
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

/** 创建通用 mock 模块 */
function setupMocks(t: any) {
  t.mock.module("../../messaging/context.js", {
    namedExports: {
      resolveOutboundSenderAccount: () => "bot-001",
    },
  });
  t.mock.module("../../../infra/transport.js", {
    namedExports: {
      sendGroupMsgBody: async () => {},
    },
  });
  t.mock.module("../../messaging/handlers/index.js", {
    namedExports: {
      prepareOutboundContent: (text: string) => text,
      buildOutboundMsgBody: (text: string) => [{ text }],
    },
  });
  t.mock.module("../../../infra/cache/member.js", {
    namedExports: {
      getMember: () => ({}),
    },
  });
}

// ============ when 条件守卫 ============

void test("guard-group-command: when 条件 - 群聊时执行", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({ isGroup: true });
  assert.equal(guardGroupCommand.when!(ctx), true);
});

void test("guard-group-command: when 条件 - C2C 时跳过", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({ isGroup: false });
  assert.equal(guardGroupCommand.when!(ctx), false);
});

// ============ handler 逻辑 ============

void test("guard-group-command: 非 Owner 执行已注册命令 → 终止管线", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({
    isGroup: true,
    rawBody: "/some-registered-cmd",
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    raw: { bot_owner_id: "owner-001", from_account: "user-001", msg_id: "msg-001" } as any,
    core: {
      channel: {
        text: { hasControlCommand: () => true },
      },
    } as any,
    config: {} as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardGroupCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "非 Owner 应终止管线");
});

void test("guard-group-command: Owner 执行已注册命令 → 放行", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({
    isGroup: true,
    rawBody: "/some-registered-cmd",
    groupCode: "group-001" as any,
    fromAccount: "owner-001",
    raw: { bot_owner_id: "owner-001", from_account: "owner-001" } as any,
    core: {
      channel: {
        text: { hasControlCommand: () => true },
      },
    } as any,
    config: {} as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardGroupCommand.handler(ctx, next);

  assert.equal(wasCalled(), true, "Owner 应放行");
});

void test("guard-group-command: 非已注册命令 → 放行（当作普通文本）", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({
    isGroup: true,
    rawBody: "/random-text",
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    raw: { bot_owner_id: "owner-001", from_account: "user-001" } as any,
    core: {
      channel: {
        text: { hasControlCommand: () => false },
      },
    } as any,
    config: {} as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardGroupCommand.handler(ctx, next);

  assert.equal(wasCalled(), true, "非注册命令应放行");
});

void test("guard-group-command: 普通文本消息 → 放行", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({
    isGroup: true,
    rawBody: "你好",
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    raw: { from_account: "user-001" } as any,
    core: {
      channel: {
        text: { hasControlCommand: () => false },
      },
    } as any,
    config: {} as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardGroupCommand.handler(ctx, next);

  assert.equal(wasCalled(), true);
});
