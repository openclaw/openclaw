import { describe, expect, it } from "vitest";
import {
  buildWechatLinuxBodyForAgent,
  buildWechatLinuxBodyForSearch,
  buildWechatLinuxLinkUnderstanding,
  buildWechatLinuxMediaUnderstanding,
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
    ).toBe("See attachment\n\n消息类型: image\n\n分析: Image OCR: project plan");
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

  it("adds rich media context for voice and link documents", () => {
    const body = buildWechatLinuxBodyForAgent({
      local_id: 3,
      timestamp: 1_700_000_000,
      time: "19:36:48",
      base_type: 34,
      chat_id: "wxid_alice",
      chat_name: "Alice",
      chat_type: "direct",
      sender_id: "wxid_alice",
      sender_display: "Alice",
      content: "语音 12s",
      analysis_text: "",
      normalized_kind: "media_asset",
      type_label: "语音",
      details: {
        wechat_transcript: "明天下午三点开会",
        url: "https://mp.weixin.qq.com/s/example",
        title: "会议安排",
      },
      artifacts: {},
      document: {
        status: "ok",
        title: "会议安排",
        summary: "一篇说明明天下午三点开会的文章。",
        doc_path: "/tmp/wechat-doc/document.md",
      },
      url_list: ["https://mp.weixin.qq.com/s/example"],
      media_paths: ["/tmp/audio.wav"],
    });
    expect(body).toContain("语音转写: 明天下午三点开会");
    expect(body).toContain("文档摘要: 一篇说明明天下午三点开会的文章。");
    expect(body).not.toContain("链接: https://mp.weixin.qq.com/s/example");
    expect(body).not.toContain("附件路径");
    expect(body).not.toContain("文档路径");
  });

  it("keeps archived paths in search view while suppressing them for agent view", () => {
    const message: Parameters<typeof buildWechatLinuxBodyForAgent>[0] = {
      local_id: 4,
      timestamp: 1_700_000_000,
      base_type: 3,
      chat_id: "wxid_alice",
      chat_name: "Alice",
      chat_type: "direct",
      sender_id: "wxid_alice",
      sender_display: "Alice",
      content: "图片",
      analysis_text: "白板上写着下周迭代计划。",
      normalized_kind: "image",
      details: {},
      artifacts: {},
      media_paths: ["/tmp/wechat-doc/media/photo.png"],
    };

    expect(buildWechatLinuxBodyForAgent(message)).not.toContain("/tmp/wechat-doc/media/photo.png");
    expect(buildWechatLinuxBodyForSearch(message)).toContain("/tmp/wechat-doc/media/photo.png");
  });

  it("maps bridge preprocessing into upstream media and link outputs", () => {
    const message: Parameters<typeof buildWechatLinuxMediaUnderstanding>[0] = {
      local_id: 5,
      timestamp: 1_700_000_000,
      base_type: 43,
      chat_id: "wxid_alice",
      chat_name: "Alice",
      chat_type: "direct",
      sender_id: "wxid_alice",
      sender_display: "Alice",
      content: "视频",
      analysis_text: "画面显示会议室白板和燃尽图。",
      normalized_kind: "video",
      details: {
        wechat_transcript: "今晚八点发布",
      },
      artifacts: {},
      document: {
        status: "ok",
        title: "发布通知",
        summary: "总结了今晚八点发布的安排。",
      },
      media_paths: ["/tmp/video.mp4"],
      media_types: ["video/mp4"],
    };

    expect(buildWechatLinuxMediaUnderstanding(message)).toEqual([
      {
        kind: "audio.transcription",
        attachmentIndex: 0,
        text: "今晚八点发布",
        provider: "wechat-linux",
      },
      {
        kind: "video.description",
        attachmentIndex: 0,
        text: "画面显示会议室白板和燃尽图。",
        provider: "wechat-linux",
      },
    ]);
    expect(buildWechatLinuxLinkUnderstanding(message)).toEqual([
      "[Link Document]\nTitle:\n发布通知\nSummary:\n总结了今晚八点发布的安排。",
    ]);
  });
});
