/**
 * 中间件 resolve-route 单元测试
 *
 * 测试范围：Agent 路由解析、when 条件守卫
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

let mockEnvelopeResult = {
  storePath: "/tmp/store",
  envelopeOptions: {} as Record<string, unknown>,
  previousTimestamp: undefined as number | undefined,
};

let mockRegistered = false;

function setupMocks(
  t: any,
  envelopeResult?: {
    storePath?: string;
    envelopeOptions?: Record<string, unknown>;
    previousTimestamp?: number;
  },
) {
  mockEnvelopeResult = {
    storePath: envelopeResult?.storePath ?? "/tmp/store",
    envelopeOptions: envelopeResult?.envelopeOptions ?? {},
    previousTimestamp: envelopeResult?.previousTimestamp ?? undefined,
  };
  if (!mockRegistered) {
    t.mock.module("openclaw/plugin-sdk/channel-inbound", {
      namedExports: {
        resolveInboundSessionEnvelopeContext: () => ({ ...mockEnvelopeResult }),
      },
    });
    mockRegistered = true;
  }
}

// ============ handler 逻辑 ============

void test("resolve-route: C2C 场景 - 解析路由并填充 ctx", async (t) => {
  setupMocks(t, {
    storePath: "/tmp/store",
    envelopeOptions: { format: "markdown" },
    previousTimestamp: 1700000000,
  });
  const { resolveRoute } = await import("./resolve-route.js");

  const mockRoute = {
    agentId: "agent-001",
    sessionKey: "session-001",
    accountId: "bot-001",
  };

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001" } as any,
    config: {} as any,
    core: {
      channel: {
        routing: {
          resolveAgentRoute: () => mockRoute,
        },
      },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveRoute.handler(ctx, next);

  assert.deepEqual(ctx.route, mockRoute);
  assert.equal(ctx.storePath, "/tmp/store");
  assert.deepEqual(ctx.envelopeOptions, { format: "markdown" });
  assert.equal(ctx.previousTimestamp, 1700000000);
  assert.equal(wasCalled(), true);
});

void test("resolve-route: 群聊场景 - peer.kind 为 group", async (t) => {
  let capturedArgs: any = null;
  setupMocks(t, { storePath: "/tmp/store/group-session" });
  const { resolveRoute } = await import("./resolve-route.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001" } as any,
    config: {} as any,
    core: {
      channel: {
        routing: {
          resolveAgentRoute: (args: any) => {
            capturedArgs = args;
            return { agentId: "agent-002", sessionKey: "group-session", accountId: "bot-001" };
          },
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await resolveRoute.handler(ctx, next);

  assert.equal(capturedArgs.peer.kind, "group");
  assert.equal(capturedArgs.peer.id, "group-001");
  assert.equal(capturedArgs.channel, "yuanbao");
});
