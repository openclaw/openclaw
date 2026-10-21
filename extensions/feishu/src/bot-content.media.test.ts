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
const file = (file_key: string, file_name: string) => ({ file_key, file_name, is_folder: false });
const saved = (name: string, contentType: string, size = 12) => ({
  id: name,
  path: `/tmp/${name}`,
  size,
  contentType,
});
function expectFileDownload(fileKey: string, originalFilename?: string) {
  expect(saveMessageResourceFeishu).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: "msg-files", fileKey, type: "file", originalFilename }),
  );
}

describe("resolveFeishuMediaList post files[]", () => {
  beforeEach(() => {
    saveMessageResourceFeishu.mockReset();
    saveMessageResourceFeishu.mockImplementation(async ({ originalFilename, fileKey, type }) => ({
      saved: saved(
        originalFilename ?? fileKey,
        originalFilename?.endsWith(".csv")
          ? "text/csv"
          : originalFilename?.endsWith(".zip")
            ? "application/zip"
            : type === "image"
              ? "image/png"
              : "video/mp4",
        Buffer.byteLength(fileKey),
      ),
    }));
  });

  it("downloads multiple top-level files without text", async () => {
    const files = [file("file_aug", "aug.zip"), file("file_sep", "sep.zip")];
    expect(await download({ title: "", content: [[]], content_v2: [[]], files })).toEqual([
      document("aug.zip", "application/zip"),
      document("sep.zip", "application/zip"),
    ]);
    expect(saveMessageResourceFeishu.mock.calls.map(([request]) => request)).toMatchObject(
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
      saved: saved("report.pdf", "application/pdf"),
      fileName: "report.pdf",
      contentType: "application/pdf",
    });
    expect(await download({ title: "", content: [[]], files: [{ file_key: "file_pdf" }] })).toEqual(
      [document("report.pdf", "application/pdf")],
    );
    expectFileDownload("file_pdf");
  });

  it.each([undefined, "clip.csv"])("keeps inline media %s as video", async (fileName) => {
    expect(
      await download({
        title: "",
        content: [[{ tag: "media", file_key: "file_inline", file_name: fileName }]],
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
    expectFileDownload("file_usage", "usage.zip");
  });
});
