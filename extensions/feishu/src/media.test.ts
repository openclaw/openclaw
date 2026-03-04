import { describe, expect, it, vi } from "vitest";

import { createOrReuseFeishuAccountClient } from "./client";
import { sendMediaFeishu } from "./media";

vi.mock("./client", () => ({
  createOrReuseFeishuAccountClient: vi.fn(),
}));

describe("sendMediaFeishu msg_type routing", () => {
  const messageCreateMock = vi.fn();
  const messageReplyMock = vi.fn();
  const mediaUploadMock = vi.fn();
  const messageResourceGetMock = vi.fn();

  const expectMediaTimeoutClientConfigured = () => {
    expect(createOrReuseFeishuAccountClient).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  };

  beforeEach(() => {
    vi.mocked(createOrReuseFeishuAccountClient).mockReturnValue({
      message: {
        create: messageCreateMock,
        reply: messageReplyMock,
        resources: {
          get: messageResourceGetMock,
        },
      },
      im: {
        v1: {
          media: {
            upload: mediaUploadMock,
          },
        },
      },
    } as any);

    messageCreateMock.mockResolvedValue({ data: { message_id: "om_1" } });
    messageReplyMock.mockResolvedValue({ data: { message_id: "om_2" } });
    mediaUploadMock.mockResolvedValue({ data: { file_key: "file_key" } });
    messageResourceGetMock.mockResolvedValue(Buffer.from("resource-bytes"));
  });

  it("uses msg_type=media for mp4", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "clip.mp4",
    });

    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "media" }),
      }),
    );
  });

  it("uses msg_type=file for non-mp4 attachments", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("file"),
      fileName: "doc.pdf",
    });

    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "file" }),
      }),
    );
  });

  it("configures the media client timeout for image uploads", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("image"),
      fileName: "photo.png",
    });

    expectMediaTimeoutClientConfigured();
    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "image" }),
      }),
    );
  });

  it("uses msg_type=media when replying with mp4", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "clip.mp4",
      replyToMessageId: "om_parent",
      replyInThread: true,
    });

    expect(messageReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: "om_parent" },
        data: expect.objectContaining({ msg_type: "media", reply_in_thread: true }),
      }),
    );
  });
});
