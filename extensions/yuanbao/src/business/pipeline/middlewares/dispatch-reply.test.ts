/**
 * 中间件 dispatch-reply 单元测试
 *
 * 测试范围：AI 回复调度、前置检查、deliver 回调、异常处理
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

let mockRegistered = false;

function setupMocks(t: any) {
  if (!mockRegistered) {
    t.mock.module("openclaw/plugin-sdk/channel-reply-pipeline", {
      namedExports: {
        createChannelReplyPipeline: () => ({
          onModelSelected: () => {},
        }),
      },
    });
    t.mock.module("openclaw/plugin-sdk/reply-payload", {
      namedExports: {
        resolveOutboundMediaUrls: (payload: any) => payload.mediaUrls ?? [],
        normalizeOutboundReplyPayload: (payload: any) => ({
          text: payload.text ?? "",
          mediaUrls: payload.mediaUrls ?? [],
        }),
      },
    });
    t.mock.module("../../../access/ws/index.js", {
      namedExports: {
        WS_HEARTBEAT: { RUNNING: "running", FINISH: "finish" },
      },
    });
    t.mock.module("../../outbound/heartbeat.js", {
      namedExports: {
        createReplyHeartbeatController: () => ({
          emit: () => {},
          stop: () => {},
        }),
      },
    });
    mockRegistered = true;
  }
}

/**
 * 创建 dispatch-reply 专用的 mock ctx
 *
 * deliverPayloads: 模拟 AI 返回的回复块列表
 * shouldThrow: 模拟 dispatchReplyWithBufferedBlockDispatcher 抛出异常
 */
function createDispatchCtx(overrides: Record<string, any> = {}) {
  const deliverPayloads: Array<{ text?: string; mediaUrls?: string[]; kind?: string }> =
    overrides._deliverPayloads ?? [];
  const shouldThrow = overrides._shouldThrow ?? false;

  return createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    ctxPayload: { Body: "test", SessionKey: "session-001" } as any,
    route: { agentId: "agent-001", sessionKey: "session-001", accountId: "bot-001" } as any,
    storePath: "/tmp/store" as any,
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: false } as any,
    config: {} as any,
    core: {
      channel: {
        text: { convertMarkdownTables: (t: string) => t },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
            if (shouldThrow) {
              throw new Error("dispatch error");
            }
            // 模拟调用 deliver 回调
            const deliver = args.dispatcherOptions?.deliver;
            if (deliver) {
              for (const p of deliverPayloads) {
                await deliver(
                  { text: p.text ?? "", mediaUrls: p.mediaUrls ?? [] },
                  { kind: p.kind ?? "block" },
                );
              }
            }
          },
        },
      },
    } as any,
    sender: { sendText: async () => {} } as any,
    queueSession: {
      push: async () => {},
      flush: async () => true,
      abort: () => {},
    } as any,
    ...overrides,
    // 不要把内部控制字段传入 ctx
  });
}

// ============ 前置检查 ============

void test("dispatch-reply: 前置中间件未就绪 → 终止管线", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createMockCtx({
    ctxPayload: undefined,
    route: undefined,
    storePath: undefined,
    sender: undefined,
    queueSession: undefined,
  });
  const { next, wasCalled } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(wasCalled(), false, "前置中间件未就绪应终止管线");
});

// ============ 正常回复流程 ============

void test("dispatch-reply: 正常回复 - deliver 文本", async (t) => {
  const pushedItems: any[] = [];
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _deliverPayloads: [{ text: "你好，我是 AI" }],
    queueSession: {
      push: async (item: any) => {
        pushedItems.push(item);
      },
      flush: async () => true,
      abort: () => {},
    },
  });
  const { next, wasCalled } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(wasCalled(), true);
  assert.ok(pushedItems.length > 0, "应有推入的内容");
  assert.equal(pushedItems[0].type, "text");
  assert.ok(pushedItems[0].text.includes("你好，我是 AI"));
});

void test("dispatch-reply: AI 未返回内容 + 有 fallbackReply → 发送兜底", async (t) => {
  let sentFallback = false;
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _deliverPayloads: [],
    account: {
      accountId: "bot-001",
      botId: "bot-001",
      disableBlockStreaming: false,
      fallbackReply: "我暂时无法回答",
    },
    sender: {
      sendText: async (text: string) => {
        sentFallback = text === "我暂时无法回答";
      },
    },
    queueSession: {
      push: async () => {},
      flush: async () => false,
      abort: () => {},
    },
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(sentFallback, true, "应发送兜底回复");
});

// ============ 异常处理 ============

void test("dispatch-reply: dispatch 异常 → abort 队列并抛出", async (t) => {
  let aborted = false;
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _shouldThrow: true,
    queueSession: {
      push: async () => {},
      flush: async () => false,
      abort: () => {
        aborted = true;
      },
    },
  });
  const { next } = createMockNext();

  await assert.rejects(() => dispatchReply.handler(ctx, next), { message: "dispatch error" });

  assert.equal(aborted, true, "异常时应 abort 队列");
});

// ============ 媒体回复 ============

void test("dispatch-reply: deliver 包含媒体 URL", async (t) => {
  const pushedItems: any[] = [];
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _deliverPayloads: [{ text: "看这张图", mediaUrls: ["https://example.com/img.jpg"] }],
    queueSession: {
      push: async (item: any) => {
        pushedItems.push(item);
      },
      flush: async () => true,
      abort: () => {},
    },
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  const mediaItems = pushedItems.filter((i) => i.type === "media");
  assert.ok(mediaItems.length > 0, "应有媒体推入");
  assert.equal(mediaItems[0].mediaUrl, "https://example.com/img.jpg");
});

// ============ tool-kind deliver 跳过 ============

void test("dispatch-reply: tool 类型 deliver 不发送给用户", async (t) => {
  const pushedItems: any[] = [];
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _deliverPayloads: [
      { text: "tool result", kind: "tool" },
      { text: "最终回复", kind: "block" },
    ],
    queueSession: {
      push: async (item: any) => {
        pushedItems.push(item);
      },
      flush: async () => true,
      abort: () => {},
    },
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  // tool 类型不应被推入
  const textItems = pushedItems.filter((i) => i.type === "text");
  assert.equal(textItems.length, 1, "只有 block 类型应被推入");
  assert.ok(textItems[0].text.includes("最终回复"));
});
