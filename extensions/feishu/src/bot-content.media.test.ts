import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFeishuTestConfig } from "./bot.test-support.js";

type SaveMessageResourceFeishu = typeof import("./media.js").saveMessageResourceFeishu;
type SavedResourceRequest = Parameters<SaveMessageResourceFeishu>[0];

const saveMessageResourceFeishu = vi.hoisted(() => vi.fn<SaveMessageResourceFeishu>());

vi.mock("./media.js", () => ({
  saveMessageResourceFeishu,
}));

import { resolveFeishuMediaList } from "./bot-content.js";

function savedContentType(params: SavedResourceRequest): string {
  if (params.originalFilename?.endsWith(".csv")) {
    return "text/csv";
  }
  if (params.originalFilename?.endsWith(".zip")) {
    return "application/zip";
  }
  return params.type === "image" ? "image/png" : "video/mp4";
}

const cfg = createFeishuTestConfig({ dmPolicy: "open" });

describe("resolveFeishuMediaList post files[]", () => {
  beforeEach(() => {
    saveMessageResourceFeishu.mockReset();
    saveMessageResourceFeishu.mockImplementation(async (params: SavedResourceRequest) => ({
      saved: {
        id: params.originalFilename ?? params.fileKey,
        path: `/tmp/${params.originalFilename ?? params.fileKey}`,
        size: Buffer.byteLength(params.fileKey),
        contentType: savedContentType(params),
      },
    }));
  });

  it("downloads top-level files[] from the issue captioned-post payload", async () => {
    const media = await resolveFeishuMediaList({
      cfg,
      messageId: "msg-post-top-level-files",
      messageType: "post",
      content: JSON.stringify({
        title: "",
        content: [[{ tag: "text", text: "这是账本" }]],
        content_v2: [[{ tag: "text", text: "这是账本" }]],
        files: [
          {
            file_key: "file_v3_0015l_1a389bce-aabb-ccdd-eeff-1234567890ab",
            file_name: "amount-2026-08-01_2026-08-31.csv",
            is_folder: false,
          },
        ],
      }),
      maxBytes: 1024,
    });

    expect(saveMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-post-top-level-files",
        fileKey: "file_v3_0015l_1a389bce-aabb-ccdd-eeff-1234567890ab",
        type: "file",
        originalFilename: "amount-2026-08-01_2026-08-31.csv",
      }),
    );
    expect(media).toEqual([
      {
        path: "/tmp/amount-2026-08-01_2026-08-31.csv",
        contentType: "text/csv",
        kind: "document",
      },
    ]);
  });

  it("downloads multiple top-level post files[] when the body has no text", async () => {
    const media = await resolveFeishuMediaList({
      cfg,
      messageId: "msg-post-multi-files",
      messageType: "post",
      content: JSON.stringify({
        title: "",
        content: [[]],
        content_v2: [[]],
        files: [
          {
            file_key: "file_v3_zip_aug",
            file_name: "usage_data_2026-08-01_2026-08-31.zip",
            is_folder: false,
          },
          {
            file_key: "file_v3_zip_sep",
            file_name: "usage_data_2026-09-01_2026-09-18.zip",
            is_folder: false,
          },
        ],
      }),
      maxBytes: 1024,
    });

    expect(
      saveMessageResourceFeishu.mock.calls.map(([request]) => ({
        fileKey: request.fileKey,
        fileName: request.originalFilename,
        type: request.type,
      })),
    ).toEqual([
      {
        fileKey: "file_v3_zip_aug",
        fileName: "usage_data_2026-08-01_2026-08-31.zip",
        type: "file",
      },
      {
        fileKey: "file_v3_zip_sep",
        fileName: "usage_data_2026-09-01_2026-09-18.zip",
        type: "file",
      },
    ]);
    expect(media).toEqual([
      {
        path: "/tmp/usage_data_2026-08-01_2026-08-31.zip",
        contentType: "application/zip",
        kind: "document",
      },
      {
        path: "/tmp/usage_data_2026-09-01_2026-09-18.zip",
        contentType: "application/zip",
        kind: "document",
      },
    ]);
  });

  it("keeps unnamed top-level post files as documents when download supplies the filename", async () => {
    saveMessageResourceFeishu.mockImplementation(async () => ({
      saved: {
        id: "report.pdf",
        path: "/tmp/report.pdf",
        size: 12,
        contentType: "application/pdf",
      },
      fileName: "report.pdf",
      contentType: "application/pdf",
    }));

    const media = await resolveFeishuMediaList({
      cfg,
      messageId: "msg-post-unnamed-file",
      messageType: "post",
      content: JSON.stringify({
        title: "",
        content: [[]],
        files: [{ file_key: "file_pdf" }],
      }),
      maxBytes: 1024,
    });

    expect(saveMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-post-unnamed-file",
        fileKey: "file_pdf",
        type: "file",
      }),
    );
    expect(saveMessageResourceFeishu.mock.calls[0]?.[0].originalFilename).toBeUndefined();
    expect(media).toEqual([
      {
        path: "/tmp/report.pdf",
        contentType: "application/pdf",
        kind: "document",
      },
    ]);
  });

  it("keeps unnamed inline post media on the video fallback", async () => {
    const media = await resolveFeishuMediaList({
      cfg,
      messageId: "msg-post-unnamed-media",
      messageType: "post",
      content: JSON.stringify({
        title: "",
        content: [[{ tag: "media", file_key: "file_inline" }]],
      }),
      maxBytes: 1024,
    });

    expect(media).toEqual([
      {
        path: "/tmp/file_inline",
        contentType: "video/mp4",
        kind: "video",
      },
    ]);
  });

  it("keeps standalone file messages on the document download path", async () => {
    const media = await resolveFeishuMediaList({
      cfg,
      messageId: "msg-file-only",
      messageType: "file",
      content: JSON.stringify({
        file_key: "file_v3_0015l_ad981d73-aabb-ccdd-eeff-1234567890ab",
        file_name: "usage.zip",
      }),
      maxBytes: 1024,
    });

    expect(saveMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-file-only",
        fileKey: "file_v3_0015l_ad981d73-aabb-ccdd-eeff-1234567890ab",
        type: "file",
        originalFilename: "usage.zip",
      }),
    );
    expect(media).toEqual([
      {
        path: "/tmp/usage.zip",
        contentType: "application/zip",
        kind: "document",
      },
    ]);
  });
});
