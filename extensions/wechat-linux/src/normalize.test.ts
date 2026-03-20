import { describe, expect, it } from "vitest";
import {
  buildWechatLinuxBodyForAgent,
  buildWechatLinuxOutboundTarget,
  inferWechatLinuxTargetChatType,
  looksLikeWechatLinuxTargetId,
  normalizeWechatLinuxAllowEntry,
  normalizeWechatLinuxAllowlist,
  normalizeWechatLinuxMessagingTarget,
  parseWechatLinuxMessagingTarget,
  resolveWechatLinuxAllowlistMatch,
} from "./normalize.js";

describe("wechat-linux target normalization", () => {
  it("parses direct and group targets with provider prefixes", () => {
    expect(parseWechatLinuxMessagingTarget("wechat-linux:user:wxid_alice")).toEqual({
      id: "wxid_alice",
      chatType: "direct",
    });
    expect(parseWechatLinuxMessagingTarget("wechat:group:room123@chatroom")).toEqual({
      id: "room123@chatroom",
      chatType: "group",
    });
  });

  it("normalizes and infers target kinds", () => {
    expect(normalizeWechatLinuxMessagingTarget("wxid_alice")).toBe("wechat-linux:user:wxid_alice");
    expect(normalizeWechatLinuxMessagingTarget("room123@chatroom")).toBe(
      "wechat-linux:group:room123@chatroom",
    );
    expect(inferWechatLinuxTargetChatType("gh_service")).toBe("direct");
    expect(inferWechatLinuxTargetChatType("room123@chatroom")).toBe("group");
  });

  it("builds explicit outbound targets", () => {
    expect(buildWechatLinuxOutboundTarget("wechat-linux:group:room123@chatroom")).toEqual({
      id: "room123@chatroom",
      chatType: "group",
      to: "wechat-linux:group:room123@chatroom",
    });
    expect(buildWechatLinuxOutboundTarget("wxid_alice")).toEqual({
      id: "wxid_alice",
      chatType: "direct",
      to: "wechat-linux:user:wxid_alice",
    });
  });

  it("detects stable WeChat ids", () => {
    expect(looksLikeWechatLinuxTargetId("wechat-linux:user:wxid_alice")).toBe(true);
    expect(looksLikeWechatLinuxTargetId("room123@chatroom")).toBe(true);
    expect(looksLikeWechatLinuxTargetId("Alice")).toBe(false);
  });
});

describe("wechat-linux allowlists", () => {
  it("normalizes prefixes and preserves wildcard", () => {
    expect(normalizeWechatLinuxAllowEntry("wechat-linux:user:WXID_ALICE")).toBe("wxid_alice");
    expect(normalizeWechatLinuxAllowEntry("*")).toBe("*");
    expect(normalizeWechatLinuxAllowlist(["wechat:user:wxid_alice", "DM:wxid_bob", "*"])).toEqual([
      "wxid_alice",
      "wxid_bob",
      "*",
    ]);
  });

  it("matches wildcard and sender ids case insensitively", () => {
    expect(
      resolveWechatLinuxAllowlistMatch({
        allowFrom: ["*"],
        senderId: "wxid_alice",
      }),
    ).toEqual({ allowed: true, source: "*" });

    expect(
      resolveWechatLinuxAllowlistMatch({
        allowFrom: ["wxid_alice"],
        senderId: "WXID_ALICE",
      }),
    ).toEqual({ allowed: true, source: "wxid_alice" });

    expect(
      resolveWechatLinuxAllowlistMatch({
        allowFrom: ["wxid_bob"],
        senderId: "wxid_alice",
      }),
    ).toEqual({ allowed: false });
  });
});

describe("wechat-linux inbound body shaping", () => {
  it("appends distinct analysis text", () => {
    expect(
      buildWechatLinuxBodyForAgent({
        local_id: 1,
        timestamp: 1_700_000_000_000,
        chat_id: "wxid_alice",
        chat_name: "Alice",
        chat_type: "direct",
        sender_id: "wxid_alice",
        sender_display: "Alice",
        content: "See attachment",
        analysis_text: "Image OCR: project plan",
        normalized_kind: "image",
        details: {},
        artifacts: {},
      }),
    ).toBe("See attachment\n\nImage OCR: project plan");
  });

  it("avoids duplicating identical analysis text", () => {
    expect(
      buildWechatLinuxBodyForAgent({
        local_id: 2,
        timestamp: 1_700_000_000_000,
        chat_id: "wxid_alice",
        chat_name: "Alice",
        chat_type: "direct",
        sender_id: "wxid_alice",
        sender_display: "Alice",
        content: "hello",
        analysis_text: "hello",
        normalized_kind: "text",
        details: {},
        artifacts: {},
      }),
    ).toBe("hello");
  });
});
