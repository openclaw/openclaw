import { describe, expect, it } from "vitest";
import { parseWechatLinuxBridgeEnvelope, parseWechatLinuxBridgeJsonFromStdout } from "./bridge.js";

describe("wechat-linux bridge envelope parsing", () => {
  it("accepts ready events", () => {
    expect(parseWechatLinuxBridgeEnvelope('{"type":"ready","chat_count":12}')).toEqual({
      type: "ready",
      chat_count: 12,
    });
  });

  it("accepts message events", () => {
    expect(
      parseWechatLinuxBridgeEnvelope(
        JSON.stringify({
          type: "message",
          message: {
            local_id: 42,
            timestamp: 1_700_000_000_000,
            chat_id: "room123@chatroom",
            chat_name: "Project Room",
            chat_type: "group",
            sender_id: "wxid_alice",
            sender_display: "Alice",
            content: "status update",
            normalized_kind: "text",
            details: {},
            artifacts: {},
          },
        }),
      ),
    ).toEqual({
      type: "message",
      message: {
        local_id: 42,
        timestamp: 1_700_000_000_000,
        chat_id: "room123@chatroom",
        chat_name: "Project Room",
        chat_type: "group",
        sender_id: "wxid_alice",
        sender_display: "Alice",
        content: "status update",
        normalized_kind: "text",
        details: {},
        artifacts: {},
      },
    });
  });

  it("drops invalid or unrelated stdout lines", () => {
    expect(parseWechatLinuxBridgeEnvelope("")).toBeNull();
    expect(parseWechatLinuxBridgeEnvelope("not json")).toBeNull();
    expect(parseWechatLinuxBridgeEnvelope('{"type":"log","message":"hello"}')).toBeNull();
  });

  it("parses the last JSON line from noisy stdout", () => {
    expect(
      parseWechatLinuxBridgeJsonFromStdout<{ ok: boolean }>('warming up\n{"ok":true}\n', "probe"),
    ).toEqual({ ok: true });
  });
});
