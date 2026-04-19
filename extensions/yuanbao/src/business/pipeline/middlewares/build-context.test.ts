/**
 * Unit tests for build-context middleware: FinalizedMsgContext construction and group history.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ Shared mutable mock state ============

let mockRegistered = false;

function setupMocks(t: any) {
  if (!mockRegistered) {
    t.mock.module("openclaw/plugin-sdk/reply-history", {
      namedExports: {
        buildPendingHistoryContextFromMap: (opts: any) => opts.currentMessage,
        clearHistoryEntriesIfEnabled: () => {},
      },
    });
    t.mock.module("../../messaging/chat-history.js", {
      namedExports: {
        chatHistories: new Map(),
      },
    });
    mockRegistered = true;
  }
}

/** Create build-context specific mock ctx with all required fields */
function createBuildCtx(overrides: Record<string, any> = {}) {
  let _finalizedPayload: any = null;
  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    senderNickname: undefined as any,
    rewrittenBody: "test",
    mediaPaths: [],
    mediaTypes: [],
    commandAuthorized: false,
    route: { agentId: "agent-001", sessionKey: "session-001", accountId: "bot-001" } as any,
    storePath: "/tmp/store" as any,
    envelopeOptions: {} as any,
    previousTimestamp: undefined,
    raw: { msg_id: "msg-001" } as any,
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0 } as any,
    config: {} as any,
    core: {
      channel: {
        reply: {
          formatAgentEnvelope: (opts: any) => String(opts.body ?? ""),
          finalizeInboundContext: (opts: any) => {
            _finalizedPayload = opts;
            return opts;
          },
        },
      },
    } as any,
    ...overrides,
  });
  return { ctx, getFinalizedPayload: () => _finalizedPayload };
}

// ============ Handler logic ============

void test("build-context: prerequisite middleware not ready -> abort pipeline", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const ctx = createMockCtx({
    route: undefined,
    storePath: undefined,
    envelopeOptions: undefined,
  });
  const { next, wasCalled } = createMockNext();

  await buildContext.handler(ctx, next);

  assert.equal(wasCalled(), false, "should abort when prerequisites not ready");
  assert.equal(ctx.ctxPayload, undefined);
});

void test("build-context: C2C - constructs ctxPayload", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    senderNickname: "张三",
    rewrittenBody: "你好",
    envelopeOptions: { format: "markdown" },
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 10 },
  });
  const { next, wasCalled } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.equal(wasCalled(), true);
  assert.ok(ctx.ctxPayload !== undefined, "ctxPayload should be populated");
  assert.equal(payload.SenderName, "张三");
  assert.equal(payload.SenderId, "user-001");
  assert.equal(payload.ChatType, "direct");
  assert.equal(payload.Provider, "yuanbao");
});

void test("build-context: group chat - ChatType is group", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: true,
    groupCode: "group-001",
    senderNickname: "李四",
    rewrittenBody: "群消息",
    raw: { msg_id: "msg-002", group_name: "测试群" },
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 10 },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.equal(payload.ChatType, "group");
  assert.equal(payload.GroupSubject, "测试群");
});

void test("build-context: populates MediaPaths when media present", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    rewrittenBody: "看图",
    mediaPaths: ["/tmp/img1.jpg", "/tmp/img2.jpg"],
    mediaTypes: ["image", "image"],
    raw: { msg_id: "msg-003" },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.deepEqual(payload.MediaPaths, ["/tmp/img1.jpg", "/tmp/img2.jpg"]);
  assert.equal(payload.MediaPath, "/tmp/img1.jpg");
});

void test("build-context: uses fromAccount when senderNickname is empty", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    senderNickname: undefined,
    raw: { msg_id: "msg-004" },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.equal(payload.SenderName, "user-001");
});
