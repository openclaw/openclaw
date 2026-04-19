/**
 * Unit tests for guard-special-command middleware: upgrade and /issue-log owner guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

/** Create shared mock modules */
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

void test("guard-special-command: non-owner upgrade command (C2C) -> abort pipeline", async (t) => {
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

  assert.equal(wasCalled(), false, "non-owner should abort pipeline");
});

void test("guard-special-command: owner upgrade command (C2C) -> pass through", async (t) => {
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

  assert.equal(wasCalled(), true, "owner should pass through");
});

void test("guard-special-command: non-owner upgrade command (group) -> abort pipeline", async (t) => {
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

void test("guard-special-command: non-owner /issue-log (C2C) -> abort pipeline", async (t) => {
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

void test("guard-special-command: owner /issue-log (C2C) -> pass through", async (t) => {
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

void test("guard-special-command: owner /issue-log in group -> abort pipeline (redirect to DM)", async (t) => {
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

  assert.equal(wasCalled(), false, "group /issue-log should redirect to DM and abort");
});

void test("guard-special-command: normal message -> pass through", async (t) => {
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

void test("guard-special-command: /yuanbaobot-upgrade is also an upgrade command", async (t) => {
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

  assert.equal(wasCalled(), false, "second upgrade command should also be guarded");
});
