import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import {
  testing as sessionBindingTesting,
  createTestRegistry,
  registerSessionBindingAdapter,
  resolveAgentRoute,
  setActivePluginRegistry,
  type OpenClawConfig,
} from "../../test-support/monitor-route-test-support.js";
import { resolveMatrixInboundRouteAsync } from "./route.js";

const baseCfg = {
  session: { mainKey: "main" },
  agents: {
    entries: { main: {}, "sender-agent": {}, "room-agent": {}, "acp-agent": {} },
  },
} satisfies OpenClawConfig;

type RouteBinding = NonNullable<OpenClawConfig["bindings"]>[number];
const roomPeer = { kind: "channel", id: "!dm:example.org" } as const;
const senderPeer = { kind: "direct", id: "@alice:example.org" } as const;

function matrixBinding(
  agentId: string,
  peer?: NonNullable<RouteBinding["match"]["peer"]>,
  type?: RouteBinding["type"],
): RouteBinding {
  return {
    ...(type ? { type } : {}),
    agentId,
    match: { channel: "matrix", accountId: "ops", ...(peer ? { peer } : {}) },
  } as RouteBinding;
}

function config(...bindings: RouteBinding[]): OpenClawConfig {
  return { ...baseCfg, bindings };
}
type BindingAdapter = Parameters<typeof registerSessionBindingAdapter>[0];
type BindingRecord = NonNullable<ReturnType<BindingAdapter["resolveByConversation"]>>;
function runtimeBinding(
  targetSessionKey: string,
  metadata?: BindingRecord["metadata"],
  touch?: BindingAdapter["touch"],
  roomOnly = false,
) {
  registerSessionBindingAdapter({
    channel: "matrix",
    accountId: "ops",
    listBySession: () => [],
    touch,
    resolveByConversation: (conversation) =>
      roomOnly && conversation.conversationId !== roomPeer.id
        ? null
        : {
            bindingId: "ops:!dm:example.org",
            targetSessionKey,
            targetKind: "session",
            conversation,
            status: "active",
            boundAt: Date.now(),
            metadata,
          },
  });
}

function resolveDmRoute(cfg: OpenClawConfig, dmSessionScope?: "per-user" | "per-room") {
  return resolveMatrixInboundRouteAsync({
    cfg,
    accountId: "ops",
    roomId: "!dm:example.org",
    senderId: "@alice:example.org",
    isDirectMessage: true,
    dmSessionScope,
    resolveAgentRoute,
  });
}

describe("resolveMatrixInboundRouteAsync", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
    );
  });

  it("uses the DM room as a parent-peer fallback before account-level bindings", async () => {
    const cfg = config(matrixBinding("acp-agent"), matrixBinding("room-agent", roomPeer));
    const { route, configuredBinding } = await resolveDmRoute(cfg);
    expect(configuredBinding).toBeNull();
    expect(route).toMatchObject({
      agentId: "room-agent",
      matchedBy: "binding.peer.parent",
      sessionKey: "agent:room-agent:main",
    });
  });

  it("keeps configured ACP room bindings ahead of per-room DM session scope", async () => {
    const cfg = config(
      matrixBinding("room-agent", roomPeer),
      matrixBinding("acp-agent", roomPeer, "acp"),
    );
    const { route, configuredBinding } = await resolveDmRoute(cfg, "per-room");
    expect(configuredBinding?.spec.agentId).toBe("acp-agent");
    expect(route).toMatchObject({
      agentId: "acp-agent",
      matchedBy: "binding.channel",
      lastRoutePolicy: "session",
    });
    expect(route.sessionKey).toContain("agent:acp-agent:acp:binding:matrix:ops:");
    expect(route.sessionKey).not.toBe("agent:acp-agent:matrix:channel:!dm:example.org");
  });

  it("lets a global runtime binding override sender and room routes", async () => {
    const touch = vi.fn();
    runtimeBinding("global", { boundBy: "user-1", agentId: "bound" }, touch, true);
    const cfg = config(
      matrixBinding("sender-agent", senderPeer),
      matrixBinding("room-agent", roomPeer),
    );
    const { route, configuredBinding, runtimeBindingId } = await resolveDmRoute(cfg);
    expect(configuredBinding).toBeNull();
    expect(runtimeBindingId).toBe("ops:!dm:example.org");
    expect(route).toMatchObject({
      agentId: "bound",
      matchedBy: "binding.channel",
      sessionKey: "global",
      lastRoutePolicy: "session",
    });
    expect(touch).not.toHaveBeenCalled();
  });

  it.each([
    ["isolated cron run", "agent:bound:cron:job:run:run-1", undefined, null],
    [
      "opaque plugin target",
      "plugin-thread-1",
      { pluginBindingOwner: "plugin", pluginId: "demo-plugin", pluginRoot: "/tmp/demo-plugin" },
      "ops:!dm:example.org",
    ],
  ] as const)(
    "keeps the core DM route for %s",
    async (_name, targetSessionKey, metadata, expectedBindingId) => {
      runtimeBinding(targetSessionKey, metadata);
      const cfg = config(matrixBinding("sender-agent", senderPeer));
      const { route, runtimeBindingId } = await resolveDmRoute(cfg, "per-room");
      expect(route.sessionKey).toBe("agent:sender-agent:matrix:channel:!dm:example.org");
      expect(route.agentId).toBe("sender-agent");
      expect(runtimeBindingId).toBe(expectedBindingId);
    },
  );
  it("resolves session keys for a thread", async () => {
    const { route } = await resolveMatrixInboundRouteAsync({
      cfg: config(matrixBinding("main")),
      accountId: "ops",
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
      isDirectMessage: false,
      threadId: "$thread-root",
      resolveAgentRoute,
    });
    expect(route.sessionKey).toBe(
      "agent:main:matrix:channel:!room:example.org:thread:$thread-root",
    );
    expect(route.mainSessionKey).not.toContain(":thread:");
    expect(route.lastRoutePolicy).toBe("session");
  });
});
