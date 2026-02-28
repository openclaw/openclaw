import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  extractNapCatInboundMessage,
  isNapCatEventMentioningSelf,
  normalizeNapCatAllowFrom,
  resolveNapCatCommandAuthorized,
  resolveNapCatGroupConfig,
} from "./inbound.js";

describe("extractNapCatInboundMessage", () => {
  it("extracts text and image urls from segments", () => {
    const result = extractNapCatInboundMessage({
      post_type: "message",
      message_type: "group",
      message_id: 100,
      user_id: 123,
      group_id: 456,
      self_id: 789,
      time: 1_700_000_000,
      sender: { nickname: "Alice" },
      message: [
        { type: "text", data: { text: "hello " } },
        { type: "image", data: { url: "https://example.com/a.png" } },
        { type: "text", data: { text: "world" } },
      ],
    });

    expect(result).toBeTruthy();
    expect(result?.isGroup).toBe(true);
    expect(result?.senderId).toBe("123");
    expect(result?.targetId).toBe("456");
    expect(result?.rawBody).toBe("hello world");
    expect(result?.mediaUrls).toEqual(["https://example.com/a.png"]);
  });

  it("returns null for non-message events", () => {
    const result = extractNapCatInboundMessage({
      post_type: "meta_event",
      message_type: "group",
    });
    expect(result).toBeNull();
  });
});

describe("isNapCatEventMentioningSelf", () => {
  it("detects @self mention", () => {
    const result = isNapCatEventMentioningSelf({
      self_id: 10001,
      message: [{ type: "at", data: { qq: "10001" } }],
    });
    expect(result).toBe(true);
  });

  it("returns false without mention", () => {
    const result = isNapCatEventMentioningSelf({
      self_id: 10001,
      message: [{ type: "text", data: { text: "hi" } }],
    });
    expect(result).toBe(false);
  });

  it("detects CQ mention when message is string", () => {
    const result = isNapCatEventMentioningSelf({
      self_id: 10001,
      message: "[CQ:at,qq=10001] hello",
    });
    expect(result).toBe(true);
  });
});

describe("normalizeNapCatAllowFrom", () => {
  it("normalizes and deduplicates entries", () => {
    expect(normalizeNapCatAllowFrom(["qq:user:1", "1", " group:2 "])).toEqual(["1", "2"]);
  });
});

describe("resolveNapCatGroupConfig", () => {
  it("applies wildcard defaults when exact group omits fields", () => {
    const result = resolveNapCatGroupConfig({
      groupId: "123",
      groups: {
        "*": {
          requireMention: false,
          allowFrom: ["111"],
        },
        "123": {
          allow: true,
        },
      },
    });

    expect(result).toEqual({
      matched: true,
      allow: true,
      requireMention: false,
      allowFrom: ["111"],
      enabled: undefined,
    });
  });
});

describe("resolveNapCatCommandAuthorized", () => {
  it("returns undefined when command auth should not be computed", () => {
    const resolveFromAuthorizers = vi.fn(() => false);
    const result = resolveNapCatCommandAuthorized({
      cfg: {} as OpenClawConfig,
      rawBody: "hello",
      senderId: "123",
      effectiveAllowFrom: ["123"],
      effectiveGroupAllowFrom: [],
      shouldComputeCommandAuthorized: () => false,
      resolveCommandAuthorizedFromAuthorizers: resolveFromAuthorizers,
    });
    expect(result).toBeUndefined();
    expect(resolveFromAuthorizers).not.toHaveBeenCalled();
  });

  it("resolves authorization from effective allowlists when command auth is required", () => {
    const resolveFromAuthorizers = vi.fn(() => false);
    const result = resolveNapCatCommandAuthorized({
      cfg: {} as OpenClawConfig,
      rawBody: "/status",
      senderId: "999",
      effectiveAllowFrom: ["123"],
      effectiveGroupAllowFrom: ["456"],
      shouldComputeCommandAuthorized: () => true,
      resolveCommandAuthorizedFromAuthorizers: resolveFromAuthorizers,
    });

    expect(result).toBe(false);
    expect(resolveFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [
        { configured: true, allowed: false },
        { configured: true, allowed: false },
      ],
    });
  });
});
