import { describe, expect, it } from "vitest";
import { parseNovaInboundMessage } from "./inbound.js";

describe("parseNovaInboundMessage", () => {
  it("parses a valid message", () => {
    const raw = JSON.stringify({
      action: "message",
      userId: "user-42",
      text: "Hello, world!",
      messageId: "msg-001",
      timestamp: 1707500000000,
    });
    expect(parseNovaInboundMessage(raw)).toEqual({
      action: "message",
      userId: "user-42",
      text: "Hello, world!",
      messageId: "msg-001",
      timestamp: 1707500000000,
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseNovaInboundMessage("not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseNovaInboundMessage('"hello"')).toBeNull();
    expect(parseNovaInboundMessage("42")).toBeNull();
    expect(parseNovaInboundMessage("null")).toBeNull();
  });

  it("returns null when action is not 'message'", () => {
    const raw = JSON.stringify({
      action: "pong",
      userId: "user-42",
      text: "Hello",
      messageId: "msg-001",
      timestamp: 1707500000000,
    });
    expect(parseNovaInboundMessage(raw)).toBeNull();
  });

  it("returns null when userId is missing", () => {
    const raw = JSON.stringify({
      action: "message",
      text: "Hello",
      messageId: "msg-001",
      timestamp: 1707500000000,
    });
    expect(parseNovaInboundMessage(raw)).toBeNull();
  });

  it("returns null when userId is empty", () => {
    const raw = JSON.stringify({
      action: "message",
      userId: "  ",
      text: "Hello",
      messageId: "msg-001",
      timestamp: 1707500000000,
    });
    expect(parseNovaInboundMessage(raw)).toBeNull();
  });

  it("returns null when messageId is missing", () => {
    const raw = JSON.stringify({
      action: "message",
      userId: "user-42",
      text: "Hello",
      timestamp: 1707500000000,
    });
    expect(parseNovaInboundMessage(raw)).toBeNull();
  });

  it("returns null when messageId is empty", () => {
    const raw = JSON.stringify({
      action: "message",
      userId: "user-42",
      text: "Hello",
      messageId: "",
      timestamp: 1707500000000,
    });
    expect(parseNovaInboundMessage(raw)).toBeNull();
  });

  it("accepts empty text", () => {
    const raw = JSON.stringify({
      action: "message",
      userId: "user-42",
      text: "",
      messageId: "msg-001",
      timestamp: 1707500000000,
    });
    const result = parseNovaInboundMessage(raw);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("");
  });

  it("defaults timestamp to Date.now() when missing", () => {
    const before = Date.now();
    const raw = JSON.stringify({
      action: "message",
      userId: "user-42",
      text: "Hello",
      messageId: "msg-001",
    });
    const result = parseNovaInboundMessage(raw);
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBeGreaterThanOrEqual(before);
    expect(result!.timestamp).toBeLessThanOrEqual(after);
  });

  it("handles non-string text gracefully", () => {
    const raw = JSON.stringify({
      action: "message",
      userId: "user-42",
      text: 123,
      messageId: "msg-001",
      timestamp: 1707500000000,
    });
    const result = parseNovaInboundMessage(raw);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("");
  });

  it("trims userId and messageId", () => {
    const raw = JSON.stringify({
      action: "message",
      userId: "  user-42  ",
      text: "Hello",
      messageId: "  msg-001  ",
      timestamp: 1707500000000,
    });
    const result = parseNovaInboundMessage(raw);
    expect(result?.userId).toBe("user-42");
    expect(result?.messageId).toBe("msg-001");
  });

  it("returns null for array input", () => {
    expect(parseNovaInboundMessage("[]")).toBeNull();
  });
});
