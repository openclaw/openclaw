import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuSendTargetMock = vi.hoisted(() => vi.fn());
const resolveMarkdownTableModeMock = vi.hoisted(() => vi.fn(() => "preserve"));
const convertMarkdownTablesMock = vi.hoisted(() => vi.fn((text: string) => text));

vi.mock("./send-target.js", () => ({
  resolveFeishuSendTarget: resolveFeishuSendTargetMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: resolveMarkdownTableModeMock,
        convertMarkdownTables: convertMarkdownTablesMock,
      },
    },
  }),
}));

import { sendCardFeishu, sendMessageFeishu } from "./send.js";

describe("Feishu reply fallback for withdrawn/deleted targets", () => {
  const replyMock = vi.fn();
  const createMock = vi.fn();

  async function expectFallbackResult(
    send: () => Promise<{ messageId?: string }>,
    expectedMessageId: string,
  ) {
    const result = await send();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe(expectedMessageId);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: {
          message: {
            reply: replyMock,
            create: createMock,
          },
        },
      },
      receiveId: "ou_target",
      receiveIdType: "open_id",
    });
  });

  it("falls back to create for withdrawn post replies", async () => {
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_new" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          text: "hello",
          replyToMessageId: "om_parent",
        }),
      "om_new",
    );
  });

  it("falls back to create for withdrawn card replies", async () => {
    replyMock.mockResolvedValue({
      code: 231003,
      msg: "The message is not found",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_card_new" },
    });

    await expectFallbackResult(
      () =>
        sendCardFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          card: { schema: "2.0" },
          replyToMessageId: "om_parent",
        }),
      "om_card_new",
    );
  });

  it("still throws for non-withdrawn reply failures", async () => {
    replyMock.mockResolvedValue({
      code: 999999,
      msg: "unknown failure",
    });

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        text: "hello",
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow("Feishu reply failed");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("falls back to create when reply throws a withdrawn SDK error", async () => {
    const sdkError = Object.assign(new Error("request failed"), { code: 230011 });
    replyMock.mockRejectedValue(sdkError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_thrown_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          text: "hello",
          replyToMessageId: "om_parent",
        }),
      "om_thrown_fallback",
    );
  });

  it("falls back to create when card reply throws a not-found AxiosError", async () => {
    const axiosError = Object.assign(new Error("Request failed"), {
      response: { status: 200, data: { code: 231003, msg: "The message is not found" } },
    });
    replyMock.mockRejectedValue(axiosError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_axios_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendCardFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          card: { schema: "2.0" },
          replyToMessageId: "om_parent",
        }),
      "om_axios_fallback",
    );
  });

  it("re-throws non-withdrawn thrown errors for text messages", async () => {
    const sdkError = Object.assign(new Error("rate limited"), { code: 99991400 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        text: "hello",
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow("rate limited");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("re-throws non-withdrawn thrown errors for card messages", async () => {
    const sdkError = Object.assign(new Error("permission denied"), { code: 99991401 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendCardFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        card: { schema: "2.0" },
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow("permission denied");

    expect(createMock).not.toHaveBeenCalled();
  });
});
