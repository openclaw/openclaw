// Feishu tests cover media.sendImageFeishu and media.sendFileFeishu
// route through the sendReplyOrFallbackDirect wrapper, matching the text/card
// reply-fallback contract at send.reply-fallback.test.ts.
//
// These tests verify issue #98311: a withdrawn/recalled reply target that
// would drop the text reply should also fall back to a top-level create()
// for image and file replies.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuSendTargetMock = vi.hoisted(() => vi.fn());

vi.mock("./send-target.js", () => ({
  resolveFeishuSendTarget: resolveFeishuSendTargetMock,
}));

vi.mock("./runtime.js", () => ({
  setFeishuRuntime: vi.fn(),
  getFeishuRuntime: () => ({
    channel: { text: {} },
  }),
}));

let sendImageFeishu: typeof import("./media.js").sendImageFeishu;
let sendFileFeishu: typeof import("./media.js").sendFileFeishu;

describe("Feishu media reply fallback for withdrawn/deleted targets", () => {
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

  beforeAll(async () => {
    ({ sendImageFeishu, sendFileFeishu } = await import("./media.js"));
  });

  afterAll(() => {
    vi.doUnmock("./send-target.js");
    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });

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

  it("falls back to create for image replies to a withdrawn target (code 230011)", async () => {
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_image_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendImageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          imageKey: "img_v3_xxx",
          replyToMessageId: "om_parent",
        }),
      "om_image_fallback",
    );
  });

  it("falls back to create for image replies to a not-found target (code 231003)", async () => {
    replyMock.mockResolvedValue({
      code: 231003,
      msg: "The message is not found",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_image_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendImageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          imageKey: "img_v3_xxx",
          replyToMessageId: "om_parent",
        }),
      "om_image_fallback",
    );
  });

  it("falls back to create for file replies to a withdrawn target (code 230011)", async () => {
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_file_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendFileFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          fileKey: "file_v3_xxx",
          replyToMessageId: "om_parent",
        }),
      "om_file_fallback",
    );
  });

  it("still throws for non-withdrawn reply failures (image)", async () => {
    replyMock.mockResolvedValue({
      code: 9999,
      msg: "Some other error",
    });

    await expect(
      sendImageFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        imageKey: "img_v3_xxx",
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow(/Feishu image reply failed/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("still throws for non-withdrawn reply failures (file)", async () => {
    replyMock.mockResolvedValue({
      code: 9999,
      msg: "Some other error",
    });

    await expect(
      sendFileFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        fileKey: "file_v3_xxx",
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow(/Feishu file reply failed/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("falls back to create for image replies that throw a withdrawn SDK error", async () => {
    const apiError = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: { code: 230011, msg: "The message was withdrawn." },
      },
    });
    replyMock.mockRejectedValue(apiError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_image_throw_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendImageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          imageKey: "img_v3_xxx",
          replyToMessageId: "om_parent",
        }),
      "om_image_throw_fallback",
    );
  });

  it("falls back to create for file replies that throw a withdrawn SDK error", async () => {
    const apiError = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: { code: 231003, msg: "The message is not found" },
      },
    });
    replyMock.mockRejectedValue(apiError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_file_throw_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendFileFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          fileKey: "file_v3_xxx",
          replyToMessageId: "om_parent",
        }),
      "om_file_throw_fallback",
    );
  });

  it("re-throws non-withdrawn thrown errors (image)", async () => {
    const apiError = Object.assign(new Error("Request failed with status code 500"), {
      response: { status: 500, data: { code: 9999, msg: "Internal error" } },
    });
    replyMock.mockRejectedValue(apiError);

    await expect(
      sendImageFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        imageKey: "img_v3_xxx",
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow(/Feishu image reply failed/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("falls back for image replies when replyInThread is false (default non-thread path)", async () => {
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_image_nonthread" },
    });

    await expectFallbackResult(
      () =>
        sendImageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          imageKey: "img_v3_xxx",
          replyToMessageId: "om_parent",
        }),
      "om_image_nonthread",
    );
  });

  it("falls back for file replies without replyToMessageId (top-level create path)", async () => {
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_file_top_level" },
    });

    const result = await sendFileFeishu({
      cfg: {} as never,
      to: "user:ou_target",
      fileKey: "file_v3_xxx",
    });
    expect(replyMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("om_file_top_level");
  });
});
