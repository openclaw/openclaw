/**
 * Unit tests for prepare-sender middleware: MessageSender and QueueSession creation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ Shared mutable mock state ============

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

void test("prepare-sender: C2C - creates sender and queueSession", async (t) => {
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

  assert.ok(ctx.sender !== undefined, "sender should be injected");
  assert.ok((ctx.sender as any)._mockSender, "sender should be mock-created");
  assert.equal((ctx.sender as any).target, "user-001", "C2C target should be fromAccount");
  assert.ok(ctx.queueSession !== undefined, "queueSession should be injected");
  assert.equal(wasCalled(), true);
});

void test("prepare-sender: group - target is groupCode", async (t) => {
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

  assert.equal((ctx.sender as any).target, "group-001", "group target should be groupCode");
  assert.equal((ctx.sender as any).isGroup, true);
});

void test("prepare-sender: uses fallback sessionKey when route is empty", async (t) => {
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

  assert.ok(ctx.queueSession !== undefined, "queueSession should be injected");
  assert.equal((ctx.queueSession as any).sessionKey, "direct:user-001");
});

void test("prepare-sender: disableBlockStreaming affects strategy", async (t) => {
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
