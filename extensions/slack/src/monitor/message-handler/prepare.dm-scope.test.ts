import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { prepareSlackMessage } from "./prepare.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

const defaultAccount: ResolvedSlackAccount = createSlackTestAccount();

function createDmMessage(overrides?: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "D123",
    channel_type: "im",
    user: "UA1",
    text: "hello",
    ts: "1.000",
    ...overrides,
  } as SlackMessageEvent;
}

function createDmCtx(cfg: OpenClawConfig = {}) {
  const ctx = createInboundSlackTestContext({
    cfg: {
      channels: { slack: { enabled: true } },
      ...cfg,
    } as OpenClawConfig,
  });
  ctx.resolveUserName = async () => ({ name: "Alice" }) as never;
  return ctx;
}

type PreparedTurnRecord = {
  updateLastRoute?: {
    sessionKey?: string;
  };
};

async function prepareDm(cfg: OpenClawConfig = {}, message?: Partial<SlackMessageEvent>) {
  const prepared = await prepareSlackMessage({
    ctx: createDmCtx(cfg),
    account: defaultAccount,
    message: createDmMessage(message),
    opts: { source: "message" },
  });
  expect(prepared).toBeTruthy();
  return prepared!;
}

function getPreparedRecord(prepared: Awaited<ReturnType<typeof prepareDm>>): PreparedTurnRecord {
  return prepared.turn.record as PreparedTurnRecord;
}

describe("slack prepareSlackMessage: dmScope gate for last-route updates", () => {
  it("targets the effective peer session when dmScope is per-channel-peer", async () => {
    const prepared = await prepareDm({ session: { dmScope: "per-channel-peer" } });
    const update = getPreparedRecord(prepared).updateLastRoute;

    expect(update).toBeDefined();
    expect(update?.sessionKey).toBe(prepared.route.sessionKey);
    expect(update?.sessionKey).not.toBe("agent:main:main");
  });

  it("targets the effective peer session when dmScope is per-peer", async () => {
    const prepared = await prepareDm({ session: { dmScope: "per-peer" } });
    const update = getPreparedRecord(prepared).updateLastRoute;

    expect(update).toBeDefined();
    expect(update?.sessionKey).toBe(prepared.route.sessionKey);
    expect(update?.sessionKey).not.toBe("agent:main:main");
  });

  it("targets the effective peer session when dmScope is per-account-channel-peer", async () => {
    const prepared = await prepareDm({ session: { dmScope: "per-account-channel-peer" } });
    const update = getPreparedRecord(prepared).updateLastRoute;

    expect(update).toBeDefined();
    expect(update?.sessionKey).toBe(prepared.route.sessionKey);
    expect(update?.sessionKey).not.toBe("agent:main:main");
  });

  it("targets the main session key when dmScope is main", async () => {
    const prepared = await prepareDm({ session: { dmScope: "main" } });
    const update = getPreparedRecord(prepared).updateLastRoute;

    expect(update).toBeDefined();
    expect(update?.sessionKey).toBe("agent:main:main");
  });

  it("targets the main session key when dmScope is unset (default behavior)", async () => {
    const prepared = await prepareDm();
    const update = getPreparedRecord(prepared).updateLastRoute;

    expect(update).toBeDefined();
    expect(update?.sessionKey).toBe("agent:main:main");
  });

  it("honors binding-level dmScope overrides even when global dmScope is main", async () => {
    const prepared = await prepareDm({
      session: { dmScope: "main" },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: {
            channel: "slack",
            accountId: "default",
            peer: { kind: "direct", id: "UA1" },
          },
          session: { dmScope: "per-account-channel-peer" },
        },
      ],
    });
    const update = getPreparedRecord(prepared).updateLastRoute;

    expect(prepared.route.lastRoutePolicy).toBe("session");
    expect(update).toBeDefined();
    expect(update?.sessionKey).toBe(prepared.route.sessionKey);
    expect(update?.sessionKey).not.toBe("agent:main:main");
  });
});
