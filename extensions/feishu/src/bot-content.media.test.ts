import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFeishuTestConfig } from "./bot.test-support.js";

type SaveResource = typeof import("./media.js").saveMessageResourceFeishu;
const saveMessageResourceFeishu = vi.hoisted(() => vi.fn<SaveResource>());
vi.mock("./media.js", () => ({ saveMessageResourceFeishu }));
import { resolveFeishuMediaList } from "./bot-content.js";

const cfg = createFeishuTestConfig({ dmPolicy: "open" });
const download = (content: unknown, messageType = "post") =>
  resolveFeishuMediaList({
    cfg,
    messageId: "msg-files",
    messageType,
    content: JSON.stringify(content),
    maxBytes: 1024,
  });
const document = (path: string, contentType: string) => ({
  path: `/tmp/${path}`,
  contentType,
  kind: "document",
});

describe("resolveFeishuMediaList post files[]", () => {
  beforeEach(() => {
    saveMessageResourceFeishu.mockReset();
    saveMessageResourceFeishu.mockImplementation(async ({ originalFilename, fileKey, type }) => ({
      saved: {
        id: originalFilename ?? fileKey,
        path: `/tmp/${originalFilename ?? fileKey}`,
        size: Buffer.byteLength(fileKey),
        contentType: originalFilename?.endsWith(".csv")
          ? "text/csv"
          : originalFilename?.endsWith(".zip")
            ? "application/zip"
            : type === "image"
              ? "image/png"
              : "video/mp4",
      },
    }));
  });

  it.each([
    {
      name: "captioned",
      text: "这是账本",
      files: [{ file_key: "file_report", file_name: "report.csv", is_folder: false }],
      expected: [document("report.csv", "text/csv")],
    },
    {
      name: "multiple files without text",
      text: undefined,
      files: [
        { file_key: "file_aug", file_name: "aug.zip", is_folder: false },
        { file_key: "file_sep", file_name: "sep.zip", is_folder: false },
      ],
      expected: [document("aug.zip", "application/zip"), document("sep.zip", "application/zip")],
    },
  ])("downloads top-level files[] for $name posts", async ({ text, files, expected }) => {
    const content = [text ? [{ tag: "text", text }] : []];
    expect(await download({ title: "", content, content_v2: content, files })).toEqual(expected);
    expect(
      saveMessageResourceFeishu.mock.calls.map(([request]) => ({
        messageId: request.messageId,
        fileKey: request.fileKey,
        originalFilename: request.originalFilename,
        type: request.type,
      })),
    ).toEqual(
      files.map(({ file_key, file_name }) => ({
        messageId: "msg-files",
        fileKey: file_key,
        originalFilename: file_name,
        type: "file",
      })),
    );
  });

  it("keeps unnamed top-level files as documents when download supplies the filename", async () => {
    saveMessageResourceFeishu.mockResolvedValue({
      saved: {
        id: "report.pdf",
        path: "/tmp/report.pdf",
        size: 12,
        contentType: "application/pdf",
      },
      fileName: "report.pdf",
      contentType: "application/pdf",
    });
    expect(await download({ title: "", content: [[]], files: [{ file_key: "file_pdf" }] })).toEqual(
      [document("report.pdf", "application/pdf")],
    );
    expect(saveMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-files",
        fileKey: "file_pdf",
        type: "file",
        originalFilename: undefined,
      }),
    );
  });

  it.each([undefined, "clip.csv"])("keeps inline media %s as video", async (fileName) => {
    expect(
      await download({
        title: "",
        content: [
          [
            {
              tag: "media",
              file_key: "file_inline",
              file_name: fileName,
            },
          ],
        ],
      }),
    ).toEqual([
      {
        path: `/tmp/${fileName ?? "file_inline"}`,
        contentType: fileName ? "text/csv" : "video/mp4",
        kind: "video",
      },
    ]);
  });

  it("keeps standalone files on the document download path", async () => {
    expect(await download({ file_key: "file_usage", file_name: "usage.zip" }, "file")).toEqual([
      document("usage.zip", "application/zip"),
    ]);
    expect(saveMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-files",
        fileKey: "file_usage",
        type: "file",
        originalFilename: "usage.zip",
      }),
    );
  });
});
