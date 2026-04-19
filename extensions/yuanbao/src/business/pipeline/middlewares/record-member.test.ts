/**
 * Unit tests for record-member middleware: group member recording and when guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ Shared mutable mock state ============

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

// ============ when condition guard ============

void test("record-member: when guard - executes in group chat", async (t) => {
  setupMocks(t);
  const { recordMember } = await import("./record-member.js");

  const ctx = createMockCtx({ isGroup: true });
  assert.equal(recordMember.when!(ctx), true);
});

void test("record-member: when guard - skips in C2C", async (t) => {
  setupMocks(t);
  const { recordMember } = await import("./record-member.js");

  const ctx = createMockCtx({ isGroup: false });
  assert.equal(recordMember.when!(ctx), false);
});

// ============ Handler logic ============

void test("record-member: calls getMember().recordUser to record group member", async (t) => {
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

void test("record-member: uses fromAccount when senderNickname is empty", async (t) => {
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
