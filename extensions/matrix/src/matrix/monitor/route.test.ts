import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import {
  __testing as sessionBindingTesting,
  createTestRegistry,
  registerSessionBindingAdapter,
  resolveAgentRoute,
  setActivePluginRegistry,
  type OpenClawConfig,
} from "../../test-support/monitor-route-test-support.js";
import { resolveMatrixInboundRoute } from "./route.js";

const baseCfg = {
  session: { mainKey: "main" },
  agents: {
    list: [{ id: "main" }, { id: "sender-agent" }, { id: "room-agent" }, { id: "acp-agent" }],
  },
} satisfies OpenClawConfig;

function resolveDmRoute(cfg: OpenClawConfig) {
  return resolveMatrixInboundRoute({
    cfg,
    accountId: "ops",
    roomId: "!dm:example.org",
    senderId: "@alice:example.org",
    isDirectMessage: true,
    resolveAgentRoute,
  });
}

describe("resolveMatrixInboundRoute", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
    );
  });

  it("prefers sender-bound DM routing over DM room fallback bindings", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        {
          agentId: "room-agent",
          match: {
            channel: "matrix",
            accountId: "ops",
            peer: { kind: "channel", id: "!dm:example.org" },
          },
        },
        {
          agentId: "sender-agent",
          match: {
            channel: "matrix",
            accountId: "ops",
            peer: { kind: "direct", id: "@alice:example.org" },
          },
        },
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg);

    expect(configuredBinding).toBeNull();
    expect(route.agentId).toBe("sender-agent");
    expect(route.matchedBy).toBe("binding.peer");
    expect(route.sessionKey).toBe("agent:sender-agent:main");
  });

  it("uses the DM room as a parent-peer fallback before account-level bindings", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        {
          agentId: "acp-agent",
          match: {
            channel: "matrix",
            accountId: "ops",
          },
        },
        {
          agentId: "room-agent",
          match: {
            channel: "matrix",
            accountId: "ops",
            peer: { kind: "channel", id: "!dm:example.org" },
          },
        },
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg);

    expect(configuredBinding).toBeNull();
    expect(route.agentId).toBe("room-agent");
    expect(route.matchedBy).toBe("binding.peer.parent");
    expect(route.sessionKey).toBe("agent:room-agent:main");
  });

  it("lets configured ACP room bindings override DM parent-peer routing", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        {
          agentId: "room-agent",
          match: {
            channel: "matrix",
            accountId: "ops",
            peer: { kind: "channel", id: "!dm:example.org" },
          },
        },
        {
          type: "acp",
          agentId: "acp-agent",
          match: {
            channel: "matrix",
            accountId: "ops",
            peer: { kind: "channel", id: "!dm:example.org" },
          },
        },
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg);

    expect(configuredBinding?.spec.agentId).toBe("acp-agent");
    expect(route.agentId).toBe("acp-agent");
    expect(route.matchedBy).toBe("binding.channel");
    expect(route.sessionKey).toContain("agent:acp-agent:acp:binding:matrix:ops:");
  });

  it("lets runtime conversation bindings override both sender and room route matches", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "!dm:example.org"
          ? {
              bindingId: "ops:!dm:example.org",
              targetSessionKey: "agent:bound:session-1",
              targetKind: "session",
              conversation: {
                channel: "matrix",
                accountId: "ops",
                conversationId: "!dm:example.org",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: { boundBy: "user-1" },
            }
          : null,
      touch,
    });

    const cfg = {
      ...baseCfg,
      bindings: [
        {
          agentId: "sender-agent",
          match: {
            channel: "matrix",
            accountId: "ops",
            peer: { kind: "direct", id: "@alice:example.org" },
          },
        },
        {
          agentId: "room-agent",
          match: {
            channel: "matrix",
            accountId: "ops",
            peer: { kind: "channel", id: "!dm:example.org" },
          },
        },
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding, runtimeBindingId } = resolveDmRoute(cfg);

    expect(configuredBinding).toBeNull();
    expect(runtimeBindingId).toBe("ops:!dm:example.org");
    expect(route.agentId).toBe("bound");
    expect(route.matchedBy).toBe("binding.channel");
    expect(route.sessionKey).toBe("agent:bound:session-1");
    expect(touch).not.toHaveBeenCalled();
  });
});

describe("resolveMatrixInboundRoute thread-isolated sessions", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
    );
  });

  it("scopes session key to thread when a thread id is provided", () => {
    const { route } = resolveMatrixInboundRoute({
      cfg: baseCfg as never,
      accountId: "ops",
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
      isDirectMessage: false,
      threadId: "$thread-root",
      resolveAgentRoute,
    });

    expect(route.sessionKey).toContain(":thread:$thread-root");
    expect(route.mainSessionKey).not.toContain(":thread:");
  });

  it("does not scope session key when thread id is absent", () => {
    const { route } = resolveMatrixInboundRoute({
      cfg: baseCfg as never,
      accountId: "ops",
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
      isDirectMessage: false,
      resolveAgentRoute,
    });

    expect(route.sessionKey).not.toContain(":thread:");
  });
});
