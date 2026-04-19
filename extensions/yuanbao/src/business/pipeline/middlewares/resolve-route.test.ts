/**
 * Unit tests for resolve-route middleware: agent route resolution.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ Shared mutable mock state ============

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

// ============ Handler logic ============

void test("resolve-route: C2C - resolves route and populates ctx", async (t) => {
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

void test("resolve-route: group chat - peer.kind is group", async (t) => {
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
