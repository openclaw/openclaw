import { beforeEach, describe, expect, it, vi } from "vitest";

const listFeishuAccountIdsMock = vi.hoisted(() => vi.fn());
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendOutboundTextMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  listFeishuAccountIds: listFeishuAccountIdsMock,
  resolveFeishuAccount: resolveFeishuAccountMock,
}));

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

vi.mock("./outbound.js", () => ({
  sendOutboundText: sendOutboundTextMock,
}));

import { feishuMessageActions } from "./actions.js";

describe("feishuMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listFeishuAccountIdsMock.mockReturnValue(["default"]);
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {},
    });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "msg_1", chatId: "chat_1" });
    sendOutboundTextMock.mockResolvedValue({ messageId: "text_1", chatId: "chat_1" });
  });

  it("advertises send when a configured feishu account exists", () => {
    expect(feishuMessageActions.listActions?.({ cfg: {} as any })).toEqual(["send"]);
  });

  it("returns no actions when feishu is not configured", () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      accountId: "default",
      enabled: true,
      configured: false,
      config: {},
    });

    expect(feishuMessageActions.listActions?.({ cfg: {} as any })).toEqual([]);
  });

  it("sends buffer-based images through sendMediaFeishu", async () => {
    const payload = Buffer.from("hello-image").toString("base64");

    const result = await feishuMessageActions.handleAction?.({
      action: "send",
      params: {
        to: "user:ou_target",
        message: "caption",
        buffer: payload,
        mimeType: "image/png",
      },
      cfg: {} as any,
      accountId: "default",
      mediaLocalRoots: ["/workspace"],
    } as any);

    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou_target",
        text: "caption",
        accountId: "default",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou_target",
        accountId: "default",
        fileName: "image.png",
        mediaBuffer: Buffer.from("hello-image"),
      }),
    );
    expect(result?.details).toEqual(
      expect.objectContaining({ ok: true, to: "user:ou_target", messageId: "msg_1" }),
    );
  });

  it("forwards local-path sends with mediaLocalRoots to sendMediaFeishu", async () => {
    await feishuMessageActions.handleAction?.({
      action: "send",
      params: {
        to: "user:ou_target",
        filePath: "/allowed/workspace/pic.png",
        replyTo: "om_reply_1",
      },
      cfg: {} as any,
      accountId: "default",
      mediaLocalRoots: ["/allowed/workspace"],
    } as any);

    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou_target",
        mediaUrl: "/allowed/workspace/pic.png",
        fileName: "pic.png",
        replyToMessageId: "om_reply_1",
        mediaLocalRoots: ["/allowed/workspace"],
      }),
    );
  });

  it("returns the text message id for text-only sends", async () => {
    const result = await feishuMessageActions.handleAction?.({
      action: "send",
      params: {
        to: "user:ou_target",
        message: "hello",
      },
      cfg: {} as any,
      accountId: "default",
    } as any);

    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou_target",
        text: "hello",
        accountId: "default",
      }),
    );
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(result?.details).toEqual(
      expect.objectContaining({ ok: true, to: "user:ou_target", messageId: "text_1" }),
    );
  });

  it("throws when send lacks text and media", async () => {
    await expect(
      feishuMessageActions.handleAction?.({
        action: "send",
        params: { to: "user:ou_target" },
        cfg: {} as any,
      } as any),
    ).rejects.toThrow("send requires text or media");
  });
});
