import { describe, expect, it } from "vitest";
import { formatWechatLinuxSearchSummary } from "./search-tools.js";

describe("wechat-linux search tool formatting", () => {
  it("formats recent search hits with chat and snippet context", () => {
    expect(
      formatWechatLinuxSearchSummary({
        ok: true,
        search_kind: "image",
        query: "甘特图",
        chat_id: "room123@chatroom",
        chat_name: "项目群",
        scanned: 120,
        total: 2,
        matches: [
          {
            local_id: 42,
            timestamp: 1_700_000_000,
            time: "19:36:48",
            chat_id: "room123@chatroom",
            chat_name: "项目群",
            chat_type: "group",
            sender_id: "wxid_alice",
            sender_display: "Alice",
            content: "图片",
            analysis_text: "图片内容是项目甘特图，里程碑在下周四。",
            normalized_kind: "media_asset",
            type_label: "图片",
            details: {},
            artifacts: {},
            media_paths: ["/tmp/gantt.png"],
          },
        ],
      }),
    ).toContain("微信图片搜索命中 1/2 条");
  });
});
