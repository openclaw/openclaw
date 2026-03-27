/**
 * Unit tests for GenPark Channel Plugin
 *
 * Tests inbound webhook parsing, outbound message routing,
 * and session key normalization.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeSessionKey,
  parseChannelTarget,
  genparkPlugin,
} from "./channel.ts";

// ---------------------------------------------------------------------------
// Session Key Normalization
// ---------------------------------------------------------------------------

describe("normalizeSessionKey", () => {
  it("should create a session key from circleId only", () => {
    const key = normalizeSessionKey("circle-abc");
    expect(key).toBe("genpark:circle-abc");
  });

  it("should create a session key from circleId and threadId", () => {
    const key = normalizeSessionKey("circle-abc", "thread-xyz");
    expect(key).toBe("genpark:circle-abc:thread-xyz");
  });

  it("should handle empty threadId as circleId-only", () => {
    const key = normalizeSessionKey("circle-abc", undefined);
    expect(key).toBe("genpark:circle-abc");
  });
});

// ---------------------------------------------------------------------------
// Parse Channel Target
// ---------------------------------------------------------------------------

describe("parseChannelTarget", () => {
  it("should parse full genpark:circleId:threadId target", () => {
    const result = parseChannelTarget("genpark:circle-1:thread-2");
    expect(result).toEqual({ circleId: "circle-1", threadId: "thread-2" });
  });

  it("should parse genpark:circleId target without threadId", () => {
    const result = parseChannelTarget("genpark:circle-1");
    expect(result).toEqual({ circleId: "circle-1" });
  });

  it("should fallback to treating entire string as circleId", () => {
    const result = parseChannelTarget("some-random-id");
    expect(result).toEqual({ circleId: "some-random-id" });
  });
});

// ---------------------------------------------------------------------------
// Inbound Webhook Handling
// ---------------------------------------------------------------------------

describe("genparkPlugin.handleInbound", () => {
  const basePayload = {
    event: "message.created" as const,
    data: {
      id: "msg-1",
      circleId: "circle-abc",
      threadId: "thread-xyz",
      authorId: "user-123",
      authorName: "Test User",
      content: "Hello from GenPark!",
      createdAt: "2026-03-26T10:00:00Z",
    },
  };

  it("should parse a valid inbound message", () => {
    const result = genparkPlugin.handleInbound(basePayload);
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("genpark:circle-abc:thread-xyz");
    expect(result!.sender).toBe("user-123");
    expect(result!.senderName).toBe("Test User");
    expect(result!.content).toBe("Hello from GenPark!");
  });

  it("should skip messages from the bot itself", () => {
    const botPayload = {
      ...basePayload,
      data: { ...basePayload.data, authorId: "openclaw-bot" },
    };
    const result = genparkPlugin.handleInbound(botPayload);
    expect(result).toBeNull();
  });

  it("should handle messages without threadId", () => {
    const noThreadPayload = {
      ...basePayload,
      data: { ...basePayload.data, threadId: undefined },
    };
    const result = genparkPlugin.handleInbound(noThreadPayload);
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("genpark:circle-abc");
  });

  it("should include raw payload in result", () => {
    const result = genparkPlugin.handleInbound(basePayload);
    expect(result!.raw).toEqual(basePayload);
  });
});

// ---------------------------------------------------------------------------
// Plugin Interface
// ---------------------------------------------------------------------------

describe("genparkPlugin structure", () => {
  it("should have the correct plugin id", () => {
    expect(genparkPlugin.id).toBe("genpark");
  });

  it("should have initialize method", () => {
    expect(typeof genparkPlugin.initialize).toBe("function");
  });

  it("should have sendMessage method", () => {
    expect(typeof genparkPlugin.sendMessage).toBe("function");
  });

  it("should have handleInbound method", () => {
    expect(typeof genparkPlugin.handleInbound).toBe("function");
  });

  it("should have shutdown method", () => {
    expect(typeof genparkPlugin.shutdown).toBe("function");
  });
});
