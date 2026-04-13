import { describe, expect, it, vi } from "vitest";

const mockBuildRoute = vi.fn(
  (params: { peer: { kind: string; id: string }; chatType: string; from: string; to: string }) =>
    params,
);

vi.mock("openclaw/plugin-sdk/core", () => ({
  buildChannelOutboundSessionRoute: (...args: unknown[]) =>
    mockBuildRoute(args[0] as Parameters<typeof mockBuildRoute>[0]),
}));

// Import after mocks are set up
import { resolveRoamOutboundSessionRoute } from "./session-route.js";

const baseCfg = {} as Parameters<typeof resolveRoamOutboundSessionRoute>[0]["cfg"];

describe("resolveRoamOutboundSessionRoute", () => {
  it("detects group target from roam:group: prefix", () => {
    const result = resolveRoamOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "default",
      target: "roam:group:chat-123",
    });

    expect(result).toBeDefined();
    expect(mockBuildRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "chat-123" },
        chatType: "group",
        from: "roam:group:chat-123",
      }),
    );
  });

  it("detects DM target from roam:dm: prefix", () => {
    const result = resolveRoamOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "default",
      target: "roam:dm:user-456",
    });

    expect(result).toBeDefined();
    expect(mockBuildRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "direct", id: "user-456" },
        chatType: "direct",
        from: "roam:user-456",
      }),
    );
  });

  it("detects DM target from roam:user: prefix", () => {
    resolveRoamOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "default",
      target: "roam:user:user-789",
    });

    expect(mockBuildRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "direct", id: "user-789" },
        chatType: "direct",
      }),
    );
  });

  it("defaults bare target to group", () => {
    resolveRoamOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "default",
      target: "roam:some-chat-id",
    });

    expect(mockBuildRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "some-chat-id" },
        chatType: "group",
      }),
    );
  });

  it("uses resolvedTarget.kind='user' to detect DM even for bare target", () => {
    resolveRoamOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "default",
      target: "roam:some-chat-id",
      resolvedTarget: { to: "roam:some-chat-id", kind: "user", source: "normalized" as const },
    });

    expect(mockBuildRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "direct", id: "some-chat-id" },
        chatType: "direct",
      }),
    );
  });

  it("uses resolvedTarget.kind='channel' to detect group", () => {
    resolveRoamOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "default",
      target: "roam:dm:some-id",
      resolvedTarget: { to: "roam:some-id", kind: "channel", source: "directory" as const },
    });

    expect(mockBuildRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "some-id" },
        chatType: "group",
      }),
    );
  });

  it("returns null for empty target", () => {
    const result = resolveRoamOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "default",
      target: "",
    });

    expect(result).toBeNull();
  });
});
