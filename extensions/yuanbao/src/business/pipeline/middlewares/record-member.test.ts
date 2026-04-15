/**
 * 中间件 record-member 单元测试
 *
 * 测试范围：群成员记录、when 条件守卫
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

let recordedArgs: unknown[] = [];

let mockRegistered = false;

function setupMocks(t: any) {
  recordedArgs = [];
  if (!mockRegistered) {
    t.mock.module("../../../infra/cache/member.js", {
      namedExports: {
        getMember: () => ({
          recordUser: (...args: unknown[]) => {
            recordedArgs = args;
          },
        }),
      },
    });
    mockRegistered = true;
  }
}

// ============ when 条件守卫 ============

void test("record-member: when 条件 - 群聊时执行", async (t) => {
  setupMocks(t);
  const { recordMember } = await import("./record-member.js");

  const ctx = createMockCtx({ isGroup: true });
  assert.equal(recordMember.when!(ctx), true);
});

void test("record-member: when 条件 - C2C 时跳过", async (t) => {
  setupMocks(t);
  const { recordMember } = await import("./record-member.js");

  const ctx = createMockCtx({ isGroup: false });
  assert.equal(recordMember.when!(ctx), false);
});

// ============ handler 逻辑 ============

void test("record-member: 调用 getMember().recordUser 记录群成员", async (t) => {
  setupMocks(t);
  const { recordMember } = await import("./record-member.js");

  const ctx = createMockCtx({
    isGroup: true,
    account: { accountId: "bot-001", botId: "bot-001" } as any,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    senderNickname: "张三" as any,
  });
  const { next, wasCalled } = createMockNext();

  await recordMember.handler(ctx, next);

  assert.deepEqual(recordedArgs, ["group-001", "user-001", "张三"]);
  assert.equal(wasCalled(), true);
});

void test("record-member: senderNickname 为空时使用 fromAccount", async (t) => {
  setupMocks(t);
  const { recordMember } = await import("./record-member.js");

  const ctx = createMockCtx({
    isGroup: true,
    account: { accountId: "bot-001", botId: "bot-001" } as any,
    groupCode: "group-001" as any,
    fromAccount: "user-002",
    senderNickname: undefined as any,
  });
  const { next } = createMockNext();

  await recordMember.handler(ctx, next);

  assert.deepEqual(recordedArgs, ["group-001", "user-002", "user-002"]);
});
