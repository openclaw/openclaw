/**
 * 中间件 build-context 单元测试
 *
 * 测试范围：FinalizedMsgContext 构建、when 条件守卫、群聊历史上下文
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

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

/** 创建 build-context 专用的 mock ctx，预设所有必需字段 */
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

// ============ handler 逻辑 ============

void test("build-context: 前置中间件未就绪 → 终止管线", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const ctx = createMockCtx({
    route: undefined,
    storePath: undefined,
    envelopeOptions: undefined,
  });
  const { next, wasCalled } = createMockNext();

  await buildContext.handler(ctx, next);

  assert.equal(wasCalled(), false, "前置中间件未就绪应终止管线");
  assert.equal(ctx.ctxPayload, undefined);
});

void test("build-context: C2C 场景 - 构建 ctxPayload", async (t) => {
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
  assert.ok(ctx.ctxPayload !== undefined, "ctxPayload 应被填充");
  assert.equal(payload.SenderName, "张三");
  assert.equal(payload.SenderId, "user-001");
  assert.equal(payload.ChatType, "direct");
  assert.equal(payload.Provider, "yuanbao");
});

void test("build-context: 群聊场景 - ChatType 为 group", async (t) => {
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

void test("build-context: 有媒体时填充 MediaPaths", async (t) => {
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

void test("build-context: senderNickname 为空时使用 fromAccount", async (t) => {
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
