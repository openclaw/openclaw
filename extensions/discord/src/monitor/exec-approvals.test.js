import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions.js";
import {
  buildExecApprovalCustomId,
  extractDiscordChannelId,
  parseExecApprovalData,
  DiscordExecApprovalHandler,
  ExecApprovalButton
} from "./exec-approvals.js";
const STORE_PATH = path.join(os.tmpdir(), "openclaw-exec-approvals-test.json");
const writeStore = (store) => {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}
`, "utf8");
  clearSessionStoreCacheForTest();
};
beforeEach(() => {
  writeStore({});
  mockGatewayClientCtor.mockClear();
  mockResolveGatewayConnectionAuth.mockReset().mockImplementation(
    async (params) => {
      const configToken = params.config?.gateway?.auth?.token;
      const configPassword = params.config?.gateway?.auth?.password;
      const envToken = params.env.OPENCLAW_GATEWAY_TOKEN ?? params.env.CLAWDBOT_GATEWAY_TOKEN;
      const envPassword = params.env.OPENCLAW_GATEWAY_PASSWORD ?? params.env.CLAWDBOT_GATEWAY_PASSWORD;
      return { token: envToken ?? configToken, password: envPassword ?? configPassword };
    }
  );
});
const mockRestPost = vi.hoisted(() => vi.fn());
const mockRestPatch = vi.hoisted(() => vi.fn());
const mockRestDelete = vi.hoisted(() => vi.fn());
const gatewayClientStarts = vi.hoisted(() => vi.fn());
const gatewayClientStops = vi.hoisted(() => vi.fn());
const gatewayClientRequests = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const gatewayClientParams = vi.hoisted(() => []);
const mockGatewayClientCtor = vi.hoisted(() => vi.fn());
const mockResolveGatewayConnectionAuth = vi.hoisted(() => vi.fn());
vi.mock("../send.shared.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createDiscordClient: () => ({
      rest: {
        post: mockRestPost,
        patch: mockRestPatch,
        delete: mockRestDelete
      },
      request: (_fn, _label) => _fn()
    })
  };
});
vi.mock("../../../../src/gateway/client.js", () => ({
  GatewayClient: class {
    constructor(params) {
      this.params = params;
      gatewayClientParams.push(params);
      mockGatewayClientCtor(params);
    }
    start() {
      gatewayClientStarts();
    }
    stop() {
      gatewayClientStops();
    }
    async request() {
      return gatewayClientRequests();
    }
  }
}));
vi.mock("../../../../src/gateway/connection-auth.js", () => ({
  resolveGatewayConnectionAuth: mockResolveGatewayConnectionAuth
}));
vi.mock("../../../../src/logger.js", () => ({
  logDebug: vi.fn(),
  logError: vi.fn()
}));
function createHandler(config, accountId = "default") {
  return new DiscordExecApprovalHandler({
    token: "test-token",
    accountId,
    config,
    cfg: { session: { store: STORE_PATH } }
  });
}
function mockSuccessfulDmDelivery(params) {
  mockRestPost.mockImplementation(
    async (route, requestParams) => {
      if (params?.noteChannelId && route === Routes.channelMessages(params.noteChannelId)) {
        if (params.expectedNoteText) {
          expect(requestParams?.body?.content).toContain(params.expectedNoteText);
        }
        return { id: "note-1", channel_id: params.noteChannelId };
      }
      if (route === Routes.userChannels()) {
        return { id: "dm-1" };
      }
      if (route === Routes.channelMessages("dm-1")) {
        return { id: "msg-1", channel_id: "dm-1" };
      }
      if (params?.throwOnUnexpectedRoute) {
        throw new Error(`unexpected route: ${route}`);
      }
      return { id: "msg-unknown" };
    }
  );
}
async function expectGatewayAuthStart(params) {
  await params.handler.start();
  expect(mockResolveGatewayConnectionAuth).toHaveBeenCalledWith(
    expect.objectContaining({
      env: process.env,
      urlOverride: params.expectedUrl,
      urlOverrideSource: params.expectedSource
    })
  );
  const expectedClientParams = {
    url: params.expectedUrl
  };
  if (params.expectedToken !== void 0) {
    expectedClientParams.token = params.expectedToken;
  }
  if (params.expectedPassword !== void 0) {
    expectedClientParams.password = params.expectedPassword;
  }
  expect(mockGatewayClientCtor).toHaveBeenCalledWith(expect.objectContaining(expectedClientParams));
}
function getHandlerInternals(handler) {
  return handler;
}
function clearPendingTimeouts(handler) {
  const internals = getHandlerInternals(handler);
  for (const pending of internals.pending.values()) {
    clearTimeout(pending.timeoutId);
  }
  internals.pending.clear();
}
function createRequest(overrides = {}) {
  return {
    id: "test-id",
    request: {
      command: "echo hello",
      cwd: "/home/user",
      host: "gateway",
      agentId: "test-agent",
      sessionKey: "agent:test-agent:discord:channel:999888777",
      ...overrides
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 6e4
  };
}
beforeEach(() => {
  mockRestPost.mockReset();
  mockRestPatch.mockReset();
  mockRestDelete.mockReset();
  gatewayClientStarts.mockReset();
  gatewayClientStops.mockReset();
  gatewayClientRequests.mockReset();
  gatewayClientRequests.mockResolvedValue({ ok: true });
  gatewayClientParams.length = 0;
});
describe("buildExecApprovalCustomId", () => {
  it("encodes approval id and action", () => {
    const customId = buildExecApprovalCustomId("abc-123", "allow-once");
    expect(customId).toBe("execapproval:id=abc-123;action=allow-once");
  });
  it("encodes special characters in approval id", () => {
    const customId = buildExecApprovalCustomId("abc=123;test", "deny");
    expect(customId).toBe("execapproval:id=abc%3D123%3Btest;action=deny");
  });
});
describe("parseExecApprovalData", () => {
  it("parses valid data", () => {
    const result = parseExecApprovalData({ id: "abc-123", action: "allow-once" });
    expect(result).toEqual({ approvalId: "abc-123", action: "allow-once" });
  });
  it("parses encoded data", () => {
    const result = parseExecApprovalData({
      id: "abc%3D123%3Btest",
      action: "allow-always"
    });
    expect(result).toEqual({ approvalId: "abc=123;test", action: "allow-always" });
  });
  it("rejects invalid action", () => {
    const result = parseExecApprovalData({ id: "abc-123", action: "invalid" });
    expect(result).toBeNull();
  });
  it("rejects missing id", () => {
    const result = parseExecApprovalData({ action: "deny" });
    expect(result).toBeNull();
  });
  it("rejects missing action", () => {
    const result = parseExecApprovalData({ id: "abc-123" });
    expect(result).toBeNull();
  });
  it("rejects null/undefined input", () => {
    expect(parseExecApprovalData(null)).toBeNull();
    expect(parseExecApprovalData(void 0)).toBeNull();
  });
  it("accepts all valid actions", () => {
    expect(parseExecApprovalData({ id: "x", action: "allow-once" })?.action).toBe("allow-once");
    expect(parseExecApprovalData({ id: "x", action: "allow-always" })?.action).toBe("allow-always");
    expect(parseExecApprovalData({ id: "x", action: "deny" })?.action).toBe("deny");
  });
});
describe("roundtrip encoding", () => {
  it("encodes and decodes correctly", () => {
    const approvalId = "test-approval-with=special;chars&more";
    const action = "allow-always";
    const customId = buildExecApprovalCustomId(approvalId, action);
    const parts = customId.split(";");
    const data = {};
    for (const part of parts) {
      const match = part.match(/^([^:]+:)?([^=]+)=(.+)$/);
      if (match) {
        data[match[2]] = match[3];
      }
    }
    const result = parseExecApprovalData(data);
    expect(result).toEqual({ approvalId, action });
  });
});
describe("extractDiscordChannelId", () => {
  it("extracts channel IDs and rejects invalid session key inputs", () => {
    const cases = [
      {
        name: "standard session key",
        input: "agent:main:discord:channel:123456789",
        expected: "123456789"
      },
      {
        name: "agent-specific session key",
        input: "agent:test-agent:discord:channel:999888777",
        expected: "999888777"
      },
      {
        name: "group session key",
        input: "agent:main:discord:group:222333444",
        expected: "222333444"
      },
      {
        name: "longer session key",
        input: "agent:my-agent:discord:channel:111222333:thread:444555",
        expected: "111222333"
      },
      {
        name: "non-discord session key",
        input: "agent:main:telegram:channel:123456789",
        expected: null
      },
      {
        name: "missing channel/group segment",
        input: "agent:main:discord:dm:123456789",
        expected: null
      },
      { name: "null input", input: null, expected: null },
      { name: "undefined input", input: void 0, expected: null },
      { name: "empty input", input: "", expected: null }
    ];
    for (const testCase of cases) {
      expect(extractDiscordChannelId(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});
describe("DiscordExecApprovalHandler.shouldHandle", () => {
  it("returns false when disabled", () => {
    const handler = createHandler({ enabled: false, approvers: ["123"] });
    expect(handler.shouldHandle(createRequest())).toBe(false);
  });
  it("returns false when no approvers", () => {
    const handler = createHandler({ enabled: true, approvers: [] });
    expect(handler.shouldHandle(createRequest())).toBe(false);
  });
  it("returns true with minimal config", () => {
    const handler = createHandler({ enabled: true, approvers: ["123"] });
    expect(handler.shouldHandle(createRequest())).toBe(true);
  });
  it("filters by agent ID", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      agentFilter: ["allowed-agent"]
    });
    expect(handler.shouldHandle(createRequest({ agentId: "allowed-agent" }))).toBe(true);
    expect(handler.shouldHandle(createRequest({ agentId: "other-agent" }))).toBe(false);
    expect(handler.shouldHandle(createRequest({ agentId: null }))).toBe(false);
  });
  it("filters by session key substring", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      sessionFilter: ["discord"]
    });
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:discord:123" }))).toBe(
      true
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:telegram:123" }))).toBe(
      false
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: null }))).toBe(false);
  });
  it("filters by session key regex", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      sessionFilter: ["^agent:.*:discord:"]
    });
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:discord:123" }))).toBe(
      true
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: "other:test:discord:123" }))).toBe(
      false
    );
  });
  it("rejects unsafe nested-repetition regex in session filter", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      sessionFilter: ["(a+)+$"]
    });
    expect(handler.shouldHandle(createRequest({ sessionKey: `${"a".repeat(28)}!` }))).toBe(false);
  });
  it("matches long session keys with tail-bounded regex checks", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      sessionFilter: ["discord:tail$"]
    });
    expect(
      handler.shouldHandle(createRequest({ sessionKey: `${"x".repeat(5e3)}discord:tail` }))
    ).toBe(true);
  });
  it("filters by discord account when session store includes account", () => {
    writeStore({
      "agent:test-agent:discord:channel:999888777": {
        sessionId: "sess",
        updatedAt: Date.now(),
        origin: { provider: "discord", accountId: "secondary" },
        lastAccountId: "secondary"
      }
    });
    const handler = createHandler({ enabled: true, approvers: ["123"] }, "default");
    expect(handler.shouldHandle(createRequest())).toBe(false);
    const matching = createHandler({ enabled: true, approvers: ["123"] }, "secondary");
    expect(matching.shouldHandle(createRequest())).toBe(true);
  });
  it("combines agent and session filters", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      agentFilter: ["my-agent"],
      sessionFilter: ["discord"]
    });
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "my-agent",
          sessionKey: "agent:my-agent:discord:123"
        })
      )
    ).toBe(true);
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "other-agent",
          sessionKey: "agent:other:discord:123"
        })
      )
    ).toBe(false);
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "my-agent",
          sessionKey: "agent:my-agent:telegram:123"
        })
      )
    ).toBe(false);
  });
});
describe("DiscordExecApprovalHandler.getApprovers", () => {
  it("returns approvers for configured, empty, and undefined lists", () => {
    const cases = [
      {
        name: "configured approvers",
        config: { enabled: true, approvers: ["111", "222"] },
        expected: ["111", "222"]
      },
      {
        name: "empty approvers",
        config: { enabled: true, approvers: [] },
        expected: []
      },
      {
        name: "undefined approvers",
        config: { enabled: true },
        expected: []
      }
    ];
    for (const testCase of cases) {
      const handler = createHandler(testCase.config);
      expect(handler.getApprovers(), testCase.name).toEqual(testCase.expected);
    }
  });
});
describe("ExecApprovalButton", () => {
  function createMockHandler(approverIds) {
    const handler = createHandler({
      enabled: true,
      approvers: approverIds
    });
    handler.resolveApproval = vi.fn().mockResolvedValue(true);
    return handler;
  }
  function createMockInteraction(userId) {
    const reply = vi.fn().mockResolvedValue(void 0);
    const acknowledge = vi.fn().mockResolvedValue(void 0);
    const followUp = vi.fn().mockResolvedValue(void 0);
    const interaction = {
      userId,
      reply,
      acknowledge,
      followUp
    };
    return { interaction, reply, acknowledge, followUp };
  }
  it("denies unauthorized users with ephemeral message", async () => {
    const handler = createMockHandler(["111", "222"]);
    const ctx = { handler };
    const button = new ExecApprovalButton(ctx);
    const { interaction, reply, acknowledge } = createMockInteraction("999");
    const data = { id: "test-approval", action: "allow-once" };
    await button.run(interaction, data);
    expect(reply).toHaveBeenCalledWith({
      content: "\u26D4 You are not authorized to approve exec requests.",
      ephemeral: true
    });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(handler.resolveApproval).not.toHaveBeenCalled();
  });
  it("allows authorized user and resolves approval", async () => {
    const handler = createMockHandler(["111", "222"]);
    const ctx = { handler };
    const button = new ExecApprovalButton(ctx);
    const { interaction, reply, acknowledge } = createMockInteraction("222");
    const data = { id: "test-approval", action: "allow-once" };
    await button.run(interaction, data);
    expect(reply).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(handler.resolveApproval).toHaveBeenCalledWith("test-approval", "allow-once");
  });
  it("acknowledges allow-always interactions before resolving", async () => {
    const handler = createMockHandler(["111"]);
    const ctx = { handler };
    const button = new ExecApprovalButton(ctx);
    const { interaction, acknowledge } = createMockInteraction("111");
    const data = { id: "test-approval", action: "allow-always" };
    await button.run(interaction, data);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(handler.resolveApproval).toHaveBeenCalledWith("test-approval", "allow-always");
  });
  it("acknowledges deny interactions before resolving", async () => {
    const handler = createMockHandler(["111"]);
    const ctx = { handler };
    const button = new ExecApprovalButton(ctx);
    const { interaction, acknowledge } = createMockInteraction("111");
    const data = { id: "test-approval", action: "deny" };
    await button.run(interaction, data);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(handler.resolveApproval).toHaveBeenCalledWith("test-approval", "deny");
  });
  it("handles invalid data gracefully", async () => {
    const handler = createMockHandler(["111"]);
    const ctx = { handler };
    const button = new ExecApprovalButton(ctx);
    const { interaction, acknowledge, reply } = createMockInteraction("111");
    const data = { id: "", action: "invalid" };
    await button.run(interaction, data);
    expect(reply).toHaveBeenCalledWith({
      content: "This approval is no longer valid.",
      ephemeral: true
    });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(handler.resolveApproval).not.toHaveBeenCalled();
  });
  it("follows up with error when resolve fails", async () => {
    const handler = createMockHandler(["111"]);
    handler.resolveApproval = vi.fn().mockResolvedValue(false);
    const ctx = { handler };
    const button = new ExecApprovalButton(ctx);
    const { interaction, followUp } = createMockInteraction("111");
    const data = { id: "test-approval", action: "allow-once" };
    await button.run(interaction, data);
    expect(followUp).toHaveBeenCalledWith({
      content: "Failed to submit approval decision for **Allowed (once)**. The request may have expired or already been resolved.",
      ephemeral: true
    });
  });
  it("matches approvers with string coercion", async () => {
    const handler = createHandler({
      enabled: true,
      approvers: [111]
    });
    handler.resolveApproval = vi.fn().mockResolvedValue(true);
    const ctx = { handler };
    const button = new ExecApprovalButton(ctx);
    const { interaction, acknowledge, reply } = createMockInteraction("111");
    const data = { id: "test-approval", action: "allow-once" };
    await button.run(interaction, data);
    expect(reply).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalled();
  });
});
describe("DiscordExecApprovalHandler target config", () => {
  beforeEach(() => {
    mockRestPost.mockClear().mockResolvedValue({ id: "mock-message", channel_id: "mock-channel" });
    mockRestPatch.mockClear().mockResolvedValue({});
    mockRestDelete.mockClear().mockResolvedValue({});
  });
  it("accepts all target modes and defaults to dm when target is omitted", () => {
    const cases = [
      {
        name: "default target",
        config: { enabled: true, approvers: ["123"] },
        expectedTarget: void 0
      },
      {
        name: "channel target",
        config: {
          enabled: true,
          approvers: ["123"],
          target: "channel"
        }
      },
      {
        name: "both target",
        config: {
          enabled: true,
          approvers: ["123"],
          target: "both"
        }
      },
      {
        name: "dm target",
        config: {
          enabled: true,
          approvers: ["123"],
          target: "dm"
        }
      }
    ];
    for (const testCase of cases) {
      if ("expectedTarget" in testCase) {
        expect(testCase.config.target, testCase.name).toBe(testCase.expectedTarget);
      }
      const handler = createHandler(testCase.config);
      expect(handler.shouldHandle(createRequest()), testCase.name).toBe(true);
    }
  });
});
describe("DiscordExecApprovalHandler gateway auth", () => {
  it("passes the shared gateway token from config into GatewayClient", async () => {
    const handler = new DiscordExecApprovalHandler({
      token: "discord-bot-token",
      accountId: "default",
      config: { enabled: true, approvers: ["123"] },
      cfg: {
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token: "shared-gateway-token" }
        }
      }
    });
    await handler.start();
    expect(gatewayClientStarts).toHaveBeenCalledTimes(1);
    expect(gatewayClientParams[0]).toMatchObject({
      url: "ws://127.0.0.1:18789",
      token: "shared-gateway-token",
      password: void 0,
      scopes: ["operator.approvals"]
    });
  });
  it("prefers OPENCLAW_GATEWAY_TOKEN when config token is missing", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-gateway-token");
    const handler = new DiscordExecApprovalHandler({
      token: "discord-bot-token",
      accountId: "default",
      config: { enabled: true, approvers: ["123"] },
      cfg: {
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token" }
        }
      }
    });
    try {
      await handler.start();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(gatewayClientStarts).toHaveBeenCalledTimes(1);
    expect(gatewayClientParams[0]).toMatchObject({
      token: "env-gateway-token",
      password: void 0
    });
  });
});
describe("DiscordExecApprovalHandler timeout cleanup", () => {
  beforeEach(() => {
    mockRestPost.mockClear().mockResolvedValue({ id: "mock-message", channel_id: "mock-channel" });
    mockRestPatch.mockClear().mockResolvedValue({});
    mockRestDelete.mockClear().mockResolvedValue({});
  });
  it("cleans up request cache for the exact approval id", async () => {
    const handler = createHandler({ enabled: true, approvers: ["123"] });
    const internals = getHandlerInternals(handler);
    const requestA = { ...createRequest(), id: "abc" };
    const requestB = { ...createRequest(), id: "abc2" };
    internals.requestCache.set("abc", requestA);
    internals.requestCache.set("abc2", requestB);
    const timeoutIdA = setTimeout(() => {
    }, 0);
    const timeoutIdB = setTimeout(() => {
    }, 0);
    clearTimeout(timeoutIdA);
    clearTimeout(timeoutIdB);
    internals.pending.set("abc:dm", {
      discordMessageId: "m1",
      discordChannelId: "c1",
      timeoutId: timeoutIdA
    });
    internals.pending.set("abc2:dm", {
      discordMessageId: "m2",
      discordChannelId: "c2",
      timeoutId: timeoutIdB
    });
    await internals.handleApprovalTimeout("abc", "dm");
    expect(internals.pending.has("abc:dm")).toBe(false);
    expect(internals.requestCache.has("abc")).toBe(false);
    expect(internals.requestCache.has("abc2")).toBe(true);
    clearPendingTimeouts(handler);
  });
});
describe("DiscordExecApprovalHandler delivery routing", () => {
  beforeEach(() => {
    mockRestPost.mockClear().mockResolvedValue({ id: "mock-message", channel_id: "mock-channel" });
    mockRestPatch.mockClear().mockResolvedValue({});
    mockRestDelete.mockClear().mockResolvedValue({});
  });
  it("falls back to DM delivery when channel target has no channel id", async () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      target: "channel"
    });
    const internals = getHandlerInternals(handler);
    mockSuccessfulDmDelivery();
    const request = createRequest({ sessionKey: "agent:main:discord:dm:123" });
    await internals.handleApprovalRequested(request);
    expect(mockRestPost).toHaveBeenCalledTimes(2);
    expect(mockRestPost).toHaveBeenCalledWith(Routes.userChannels(), {
      body: { recipient_id: "123" }
    });
    expect(mockRestPost).toHaveBeenCalledWith(
      Routes.channelMessages("dm-1"),
      expect.objectContaining({
        body: expect.objectContaining({
          components: expect.any(Array)
        })
      })
    );
    clearPendingTimeouts(handler);
  });
  it("posts an in-channel note when target is dm and the request came from a non-DM discord conversation", async () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      target: "dm"
    });
    const internals = getHandlerInternals(handler);
    mockSuccessfulDmDelivery({
      noteChannelId: "999888777",
      expectedNoteText: "I sent the allowed approvers DMs",
      throwOnUnexpectedRoute: true
    });
    await internals.handleApprovalRequested(createRequest());
    expect(mockRestPost).toHaveBeenCalledWith(
      Routes.channelMessages("999888777"),
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining("I sent the allowed approvers DMs")
        })
      })
    );
    expect(mockRestPost).toHaveBeenCalledWith(
      Routes.channelMessages("dm-1"),
      expect.objectContaining({
        body: expect.any(Object)
      })
    );
    clearPendingTimeouts(handler);
  });
  it("does not post an in-channel note when the request already came from a discord DM", async () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      target: "dm"
    });
    const internals = getHandlerInternals(handler);
    mockSuccessfulDmDelivery({ throwOnUnexpectedRoute: true });
    await internals.handleApprovalRequested(
      createRequest({ sessionKey: "agent:main:discord:dm:123" })
    );
    expect(mockRestPost).not.toHaveBeenCalledWith(
      Routes.channelMessages("999888777"),
      expect.anything()
    );
    clearPendingTimeouts(handler);
  });
});
describe("DiscordExecApprovalHandler gateway auth resolution", () => {
  it("passes CLI URL overrides to shared gateway auth resolver", async () => {
    mockResolveGatewayConnectionAuth.mockResolvedValue({
      token: "resolved-token",
      password: "resolved-password"
      // pragma: allowlist secret
    });
    const handler = new DiscordExecApprovalHandler({
      token: "test-token",
      accountId: "default",
      gatewayUrl: "wss://override.example/ws",
      config: { enabled: true, approvers: ["123"] },
      cfg: { session: { store: STORE_PATH } }
    });
    await expectGatewayAuthStart({
      handler,
      expectedUrl: "wss://override.example/ws",
      expectedSource: "cli",
      expectedToken: "resolved-token",
      expectedPassword: "resolved-password"
      // pragma: allowlist secret
    });
    await handler.stop();
  });
  it("passes env URL overrides to shared gateway auth resolver", async () => {
    const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
    try {
      process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-from-env.example/ws";
      const handler = new DiscordExecApprovalHandler({
        token: "test-token",
        accountId: "default",
        config: { enabled: true, approvers: ["123"] },
        cfg: { session: { store: STORE_PATH } }
      });
      await expectGatewayAuthStart({
        handler,
        expectedUrl: "wss://gateway-from-env.example/ws",
        expectedSource: "env"
      });
      await handler.stop();
    } finally {
      if (typeof previousGatewayUrl === "string") {
        process.env.OPENCLAW_GATEWAY_URL = previousGatewayUrl;
      } else {
        delete process.env.OPENCLAW_GATEWAY_URL;
      }
    }
  });
});
