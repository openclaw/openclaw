/**
 * Unit tests for guard-group-command middleware: group command whitelist guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

/** Create common mock modules */
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

// ============ when condition guard ============

void test("guard-group-command: when guard - executes in group chat", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({ isGroup: true });
  assert.equal(guardGroupCommand.when!(ctx), true);
});

void test("guard-group-command: when guard - skips in C2C", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({ isGroup: false });
  assert.equal(guardGroupCommand.when!(ctx), false);
});

// ============ Handler logic ============

void test("guard-group-command: non-owner executes registered command -> abort pipeline", async (t) => {
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

  assert.equal(wasCalled(), false, "non-owner should abort pipeline");
});

void test("guard-group-command: owner executes registered command -> pass through", async (t) => {
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

  assert.equal(wasCalled(), true, "owner should pass through");
});

void test("guard-group-command: unregistered command -> pass through (treated as plain text)", async (t) => {
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

  assert.equal(wasCalled(), true, "unregistered command should pass through");
});

void test("guard-group-command: plain text message -> pass through", async (t) => {
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
