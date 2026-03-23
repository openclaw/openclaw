import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeSendResult, ResolvedWechatLinuxAccount } from "./types.js";

const resolveWechatLinuxAccountMock = vi.fn();
const resolveWechatLinuxBridgeTargetMock = vi.fn();
const sendWechatLinuxBridgeTextMock = vi.fn();
const sendWechatLinuxBridgeFileMock = vi.fn();
const noteRecentWechatLinuxOutboundMock = vi.fn();
const loadOutboundMediaFromUrlMock = vi.fn();

vi.mock("./accounts.js", () => ({
  resolveWechatLinuxAccount: resolveWechatLinuxAccountMock,
}));

vi.mock("./bridge.js", () => ({
  resolveWechatLinuxBridgeTarget: resolveWechatLinuxBridgeTargetMock,
  sendWechatLinuxBridgeText: sendWechatLinuxBridgeTextMock,
  sendWechatLinuxBridgeFile: sendWechatLinuxBridgeFileMock,
}));

vi.mock("./recent-outbound.js", () => ({
  noteRecentWechatLinuxOutbound: noteRecentWechatLinuxOutboundMock,
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: loadOutboundMediaFromUrlMock,
}));

const { sendWechatLinuxMedia, sendWechatLinuxText } = await import("./send.js");

const account = {
  accountId: "default",
  enabled: true,
  configured: true,
  pyWxDumpRoot: "/tmp/PyWxDump",
  pythonPath: "/usr/bin/python3",
  keyFile: "/tmp/key.json",
  outputDir: "/tmp/output",
  windowClass: "wechat",
  windowMode: "auto",
  config: {},
} satisfies ResolvedWechatLinuxAccount;

const okResult: BridgeSendResult = {
  status: "ok",
  target: "wxid_ivan",
  chat_id: "wxid_ivan",
  matched_local_id: 18,
  send_kind: "text",
};

describe("wechat-linux send retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveWechatLinuxAccountMock.mockReturnValue(account);
    resolveWechatLinuxBridgeTargetMock.mockResolvedValue({
      ok: true,
      input: "wechat-linux:user:wxid_ivan",
      chat_id: "wxid_ivan",
      chat_type: "direct",
    });
  });

  it("retries text sends once on transient focus loss", async () => {
    sendWechatLinuxBridgeTextMock
      .mockRejectedValueOnce(new Error('{"error":"send_focus_lost:focus_input:terminal"}'))
      .mockResolvedValueOnce(okResult);

    const result = await sendWechatLinuxText({
      cfg: {},
      to: "wechat-linux:user:wxid_ivan",
      text: "hello",
    });

    expect(sendWechatLinuxBridgeTextMock).toHaveBeenCalledTimes(2);
    expect(noteRecentWechatLinuxOutboundMock).toHaveBeenCalledWith("default", 18);
    expect(result).toEqual({
      messageId: "18",
      chatId: "wxid_ivan",
    });
  });

  it("does not retry non-focus-loss text failures", async () => {
    sendWechatLinuxBridgeTextMock.mockRejectedValueOnce(new Error('{"error":"target not found"}'));

    await expect(
      sendWechatLinuxText({
        cfg: {},
        to: "wechat-linux:user:wxid_ivan",
        text: "hello",
      }),
    ).rejects.toThrow("target not found");

    expect(sendWechatLinuxBridgeTextMock).toHaveBeenCalledTimes(1);
  });

  it("retries media sends once on transient focus loss", async () => {
    loadOutboundMediaFromUrlMock.mockResolvedValue({
      buffer: Buffer.from("file-data"),
      contentType: "application/pdf",
      fileName: "report.pdf",
    });
    sendWechatLinuxBridgeFileMock
      .mockRejectedValueOnce(new Error('{"error":"send_focus_lost:activate_window:terminal"}'))
      .mockResolvedValueOnce({
        ...okResult,
        send_kind: "file",
      });

    const result = await sendWechatLinuxMedia({
      cfg: {},
      to: "wechat-linux:user:wxid_ivan",
      text: "",
      mediaUrl: "file:///tmp/report.pdf",
    });

    expect(sendWechatLinuxBridgeFileMock).toHaveBeenCalledTimes(2);
    expect(noteRecentWechatLinuxOutboundMock).toHaveBeenCalledWith("default", 18);
    expect(result).toEqual({
      messageId: "18",
      chatId: "wxid_ivan",
    });
  });
});
