// Qqbot tests cover unified sender behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkedMediaApi } from "../api/media-chunked.js";
import { MediaApi } from "../api/media.js";
import { MediaFileType, type MessageResponse, type UploadMediaResponse } from "../types.js";
import { registerAccount, sendMedia } from "./sender.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const readResponseWithLimitMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/response-limit-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/response-limit-runtime")>();
  return {
    ...actual,
    readResponseWithLimit: readResponseWithLimitMock,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

const MEDIA_BYTES = Buffer.from("downloaded-media");
const UPLOAD_RESPONSE: UploadMediaResponse = {
  file_uuid: "uuid-1",
  file_info: "file-info-1",
  ttl: 3600,
};
const MESSAGE_RESPONSE: MessageResponse = {
  id: "msg-1",
  timestamp: 1781364036672,
};

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

function mockGuardedDownload(): void {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(MEDIA_BYTES),
    release: vi.fn(async () => {}),
  });
  readResponseWithLimitMock.mockResolvedValueOnce(MEDIA_BYTES);
}

describe("qqbot unified sender media upload dispatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fetchWithSsrFGuardMock.mockReset();
    readResponseWithLimitMock.mockReset();
    logger.info.mockReset();
    logger.error.mockReset();
    logger.warn.mockReset();
    logger.debug.mockReset();
  });

  it.each([
    {
      label: "image",
      kind: "image" as const,
      fileType: MediaFileType.IMAGE,
      fileName: undefined,
      content: "caption",
      mediaUrl: "https://cdn.example.com/assets/photo.png",
    },
    {
      label: "file",
      kind: "file" as const,
      fileType: MediaFileType.FILE,
      fileName: "report.pdf",
      content: undefined,
      mediaUrl: "https://cdn.example.com/assets/report.pdf",
    },
  ])(
    "uploads C2C URL $label bytes through chunked upload instead of one-shot file_data",
    async ({ kind, fileType, fileName, content, mediaUrl }) => {
      mockGuardedDownload();
      const uploadMediaSpy = vi
        .spyOn(MediaApi.prototype, "uploadMedia")
        .mockResolvedValue(UPLOAD_RESPONSE);
      const uploadChunkedSpy = vi
        .spyOn(ChunkedMediaApi.prototype, "uploadChunked")
        .mockResolvedValue(UPLOAD_RESPONSE);
      const sendMediaMessageSpy = vi
        .spyOn(MediaApi.prototype, "sendMediaMessage")
        .mockResolvedValue(MESSAGE_RESPONSE);
      const appId = `sender-test-${kind}`;
      const creds = { appId, clientSecret: "client-secret" };
      registerAccount(appId, { logger });

      const result = await sendMedia({
        target: { type: "c2c", id: "user-openid" },
        creds,
        kind,
        source: { url: mediaUrl },
        fileName,
        content,
      });

      expect(result).toBe(MESSAGE_RESPONSE);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: mediaUrl,
        maxRedirects: 0,
        signal: expect.any(AbortSignal),
      });
      expect(uploadMediaSpy).not.toHaveBeenCalled();
      expect(uploadChunkedSpy).toHaveBeenCalledOnce();
      expect(uploadChunkedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "c2c",
          targetId: "user-openid",
          fileType,
          creds,
          fileName,
        }),
      );
      const chunkedSource = uploadChunkedSpy.mock.calls[0]?.[0]?.source;
      expect(chunkedSource).toMatchObject({ kind: "buffer", fileName });
      expect(chunkedSource?.kind === "buffer" ? chunkedSource.buffer : undefined).toEqual(
        MEDIA_BYTES,
      );
      expect(sendMediaMessageSpy).toHaveBeenCalledWith("c2c", "user-openid", "file-info-1", creds, {
        msgId: undefined,
        content: kind === "image" ? content : undefined,
      });
    },
  );
});
