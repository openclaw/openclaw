/**
 * 中间件 guard-special-command 单元测试
 *
 * 测试范围：升级命令和 /issue-log 的 Owner 守卫
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

/** 创建通用 mock 模块 */
function setupMocks(t: any) {
  const UPGRADE_COMMAND_NAMES = ["/yuanbao-upgrade", "/yuanbaobot-upgrade"] as const;
  t.mock.module("../../commands/upgrade/index.js", {
    namedExports: {
      UPGRADE_COMMAND_NAMES,
      parseUpgradeCommand(rawBody: string) {
        const body = rawBody.trim();
        for (const name of UPGRADE_COMMAND_NAMES) {
          if (body === name) {
            return { matched: true };
          }
          if (body.startsWith(`${name} `)) {
            const version = body.slice(name.length + 1).trim() || undefined;
            return { matched: true, version };
          }
        }
        return { matched: false };
      },
    },
  });
  t.mock.module("../../actions/text/send.js", {
    namedExports: {
      sendText: async () => ({ ok: true }),
    },
  });
  t.mock.module("../../actions/deliver.js", {
    namedExports: {
      deliver: async () => ({ ok: true }),
    },
  });
}

void test("guard-special-command: 非 Owner 执行升级命令(C2C) → 终止管线", async (t) => {
  setupMocks(t);
  const { guardSpecialCommand } = await import("./guard-special-command.js");

  const ctx = createMockCtx({
    rawBody: "/yuanbao-upgrade",
    fromAccount: "user-001",
    isGroup: false,
    raw: { bot_owner_id: "owner-001", from_account: "user-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardSpecialCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "非 Owner 应终止管线");
});

void test("guard-special-command: Owner 执行升级命令(C2C) → 放行", async (t) => {
  setupMocks(t);
  const { guardSpecialCommand } = await import("./guard-special-command.js");

  const ctx = createMockCtx({
    rawBody: "/yuanbao-upgrade",
    fromAccount: "owner-001",
    isGroup: false,
    raw: { bot_owner_id: "owner-001", from_account: "owner-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardSpecialCommand.handler(ctx, next);

  assert.equal(wasCalled(), true, "Owner 应放行");
});

void test("guard-special-command: 非 Owner 执行升级命令(群聊) → 终止管线", async (t) => {
  setupMocks(t);
  const { guardSpecialCommand } = await import("./guard-special-command.js");

  const ctx = createMockCtx({
    rawBody: "/yuanbao-upgrade",
    fromAccount: "user-001",
    isGroup: true,
    groupCode: "group-001" as any,
    raw: { bot_owner_id: "owner-001", from_account: "user-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardSpecialCommand.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("guard-special-command: 非 Owner 执行 /issue-log(C2C) → 终止管线", async (t) => {
  setupMocks(t);
  const { guardSpecialCommand } = await import("./guard-special-command.js");

  const ctx = createMockCtx({
    rawBody: "/issue-log",
    fromAccount: "user-001",
    isGroup: false,
    raw: { bot_owner_id: "owner-001", from_account: "user-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardSpecialCommand.handler(ctx, next);

  assert.equal(wasCalled(), false);
});

void test("guard-special-command: Owner 执行 /issue-log(C2C) → 放行", async (t) => {
  setupMocks(t);
  const { guardSpecialCommand } = await import("./guard-special-command.js");

  const ctx = createMockCtx({
    rawBody: "/issue-log",
    fromAccount: "owner-001",
    isGroup: false,
    raw: { bot_owner_id: "owner-001", from_account: "owner-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardSpecialCommand.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("guard-special-command: Owner 在群聊执行 /issue-log → 终止管线（引导私聊）", async (t) => {
  setupMocks(t);
  const { guardSpecialCommand } = await import("./guard-special-command.js");

  const ctx = createMockCtx({
    rawBody: "/issue-log",
    fromAccount: "owner-001",
    isGroup: true,
    groupCode: "group-001" as any,
    raw: { bot_owner_id: "owner-001", from_account: "owner-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardSpecialCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "群聊 /issue-log 应引导私聊并终止");
});

void test("guard-special-command: 普通消息 → 放行", async (t) => {
  setupMocks(t);
  const { guardSpecialCommand } = await import("./guard-special-command.js");

  const ctx = createMockCtx({
    rawBody: "你好",
    fromAccount: "user-001",
    isGroup: false,
    raw: { bot_owner_id: "owner-001", from_account: "user-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardSpecialCommand.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("guard-special-command: /yuanbaobot-upgrade 也是升级命令", async (t) => {
  setupMocks(t);
  const { guardSpecialCommand } = await import("./guard-special-command.js");

  const ctx = createMockCtx({
    rawBody: "/yuanbaobot-upgrade",
    fromAccount: "user-001",
    isGroup: false,
    raw: { bot_owner_id: "owner-001", from_account: "user-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardSpecialCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "第二个升级命令也应被守卫");
});
