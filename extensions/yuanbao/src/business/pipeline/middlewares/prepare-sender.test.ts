/**
 * 中间件 prepare-sender 单元测试
 *
 * 测试范围：MessageSender 和 QueueSession 创建注入
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

let _capturedSenderOpts: any = null;
let capturedQueueOpts: any = null;

let mockRegistered = false;

function setupMocks(t: any) {
  _capturedSenderOpts = null;
  capturedQueueOpts = null;
  if (!mockRegistered) {
    t.mock.module("../../outbound/create-sender.js", {
      namedExports: {
        createMessageSender: (opts: any) => {
          _capturedSenderOpts = opts;
          return {
            _mockSender: true,
            isGroup: opts.isGroup,
            target: opts.target,
            sendText: async () => {},
          };
        },
      },
    });
    t.mock.module("../../outbound/queue.js", {
      namedExports: {
        createQueueSession: (opts: any) => {
          capturedQueueOpts = opts;
          return {
            _mockQueue: true,
            sessionKey: opts.sessionKey,
            push: async () => {},
            flush: async () => true,
            abort: () => {},
          };
        },
      },
    });
    mockRegistered = true;
  }
}

void test("prepare-sender: C2C 场景 - 创建 sender 和 queueSession", async (t) => {
  setupMocks(t);
  const { prepareSender } = await import("./prepare-sender.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: false } as any,
    route: { agentId: "agent-001", sessionKey: "session-001", accountId: "bot-001" } as any,
    raw: {} as any,
    config: {} as any,
    core: {
      channel: {
        text: { chunkMarkdownText: (t: string, _max: number) => [t] },
      },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await prepareSender.handler(ctx, next);

  assert.ok(ctx.sender !== undefined, "sender 应被注入");
  assert.ok((ctx.sender as any)._mockSender, "sender 应是 mock 创建的");
  assert.equal((ctx.sender as any).target, "user-001", "C2C target 应为 fromAccount");
  assert.ok(ctx.queueSession !== undefined, "queueSession 应被注入");
  assert.equal(wasCalled(), true);
});

void test("prepare-sender: 群聊场景 - target 为 groupCode", async (t) => {
  setupMocks(t);
  const { prepareSender } = await import("./prepare-sender.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: false } as any,
    route: { agentId: "agent-001", sessionKey: "group-session", accountId: "bot-001" } as any,
    raw: { msg_id: "msg-001", msg_key: "key-001" } as any,
    config: {} as any,
    core: {
      channel: {
        text: { chunkMarkdownText: (t: string, _max: number) => [t] },
      },
    } as any,
  });
  const { next } = createMockNext();

  await prepareSender.handler(ctx, next);

  assert.equal((ctx.sender as any).target, "group-001", "群聊 target 应为 groupCode");
  assert.equal((ctx.sender as any).isGroup, true);
});

void test("prepare-sender: route 为空时使用 fallback sessionKey", async (t) => {
  setupMocks(t);
  const { prepareSender } = await import("./prepare-sender.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: false } as any,
    route: undefined,
    raw: {} as any,
    config: {} as any,
    core: {
      channel: {
        text: { chunkMarkdownText: (t: string, _max: number) => [t] },
      },
    } as any,
  });
  const { next } = createMockNext();

  await prepareSender.handler(ctx, next);

  assert.ok(ctx.queueSession !== undefined, "queueSession 应被注入");
  assert.equal((ctx.queueSession as any).sessionKey, "direct:user-001");
});

void test("prepare-sender: disableBlockStreaming 影响 strategy", async (t) => {
  setupMocks(t);
  const { prepareSender } = await import("./prepare-sender.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: true } as any,
    route: { sessionKey: "session-001" } as any,
    raw: {} as any,
    config: {} as any,
    core: {
      channel: {
        text: { chunkMarkdownText: (t: string, _max: number) => [t] },
      },
    } as any,
  });
  const { next } = createMockNext();

  await prepareSender.handler(ctx, next);

  assert.equal(capturedQueueOpts.strategy, "immediate");
  assert.equal(capturedQueueOpts.mergeOnFlush, true);
});
