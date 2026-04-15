/**
 * 中间件 guard-command 单元测试
 *
 * 测试范围：控制命令授权守卫
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

let mockGateResult = { commandAuthorized: false, shouldBlock: true };
let mockGateCallback: ((opts: any) => { commandAuthorized: boolean; shouldBlock: boolean }) | null =
  null;

let mockRegistered = false;

function setupMocks(
  t: any,
  opts?: {
    gateResult?: { commandAuthorized: boolean; shouldBlock: boolean };
    gateCallback?: (opts: any) => { commandAuthorized: boolean; shouldBlock: boolean };
  },
) {
  mockGateResult = opts?.gateResult ?? { commandAuthorized: false, shouldBlock: true };
  mockGateCallback = opts?.gateCallback ?? null;
  if (!mockRegistered) {
    t.mock.module("openclaw/plugin-sdk/command-auth", {
      namedExports: {
        resolveControlCommandGate: (args: any) => {
          if (mockGateCallback) {
            return mockGateCallback(args);
          }
          return { ...mockGateResult };
        },
      },
    });
    mockRegistered = true;
  }
}

void test("guard-command: 未授权的控制命令 → 终止管线", async (t) => {
  setupMocks(t, {
    gateResult: { commandAuthorized: false, shouldBlock: true },
  });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    rawBody: "/some-command",
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => true },
      },
    } as any,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      config: { dm: { policy: "open", allowFrom: [] } },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "未授权应终止管线");
  assert.equal(ctx.commandAuthorized, false);
});

void test("guard-command: 授权的控制命令 → 放行", async (t) => {
  setupMocks(t, {
    gateResult: { commandAuthorized: true, shouldBlock: false },
  });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    rawBody: "/some-command",
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => true },
      },
    } as any,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      config: { dm: { policy: "open", allowFrom: [] } },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), true, "授权应放行");
  assert.equal(ctx.commandAuthorized, true);
});

void test("guard-command: 非控制命令 → 放行", async (t) => {
  setupMocks(t, {
    gateResult: { commandAuthorized: false, shouldBlock: false },
  });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    rawBody: "你好",
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => false },
      },
    } as any,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      config: { dm: { policy: "open", allowFrom: [] } },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), true);
  assert.equal(ctx.hasControlCommand, false);
});

void test("guard-command: DM policy closed + 不在 allowFrom → shouldBlock", async (t) => {
  setupMocks(t, {
    gateCallback: (opts: any) => {
      // 验证传入的 authorizers 参数
      const senderAllowed = opts.authorizers[0].allowed;
      return {
        commandAuthorized: false,
        shouldBlock: !senderAllowed && opts.hasControlCommand,
      };
    },
  });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    rawBody: "/restricted-cmd",
    fromAccount: "stranger",
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => true },
      },
    } as any,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      config: { dm: { policy: "closed", allowFrom: ["admin-001"] } },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "closed policy + 非允许用户应终止");
});
