import fs from "node:fs/promises";
import path from "node:path";
import { extractOriginalFilename } from "openclaw/plugin-sdk/media-runtime";
import { createTempHomeEnv, type TempHomeEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_PROXY_MAX_FILE_BYTES as MAX_FILE_BYTES } from "../browser-proxy-envelope.js";
import { persistBrowserProxyResultFiles } from "./proxy-files.js";

const MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const BINARY_MIME = "application/octet-stream";
const file = (filePath: string, contents: string | Buffer = "", mimeType?: string) => ({
  path: filePath,
  base64: Buffer.from(contents).toString("base64"),
  ...(mimeType ? { mimeType } : {}),
});

describe("persistBrowserProxyResultFiles", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-browser-proxy-files-");
  });

  afterEach(() => tempHome.restore());

  async function expectRejected(result: unknown, files: unknown, message: string) {
    const persisting = persistBrowserProxyResultFiles(result, files);
    await expect(persisting).rejects.toBeInstanceOf(Error);
    await expect(persisting).rejects.toThrow(new Error(message));
    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toHaveProperty("code", "ENOENT");
  }

  it.each([
    { sourcePath: "C:\\downloads\\quarterly-report.pdf", expectedFilename: "quarterly-report.pdf" },
    { sourcePath: "/tmp/my <file>:test!.bin", expectedFilename: "my_filetest.pdf" },
  ])("preserves a safe filename from $sourcePath", async ({ sourcePath, expectedFilename }) => {
    const contents = "%PDF-1.7 browser proxy download";
    const result = { download: { path: sourcePath, suggestedFilename: "website-title.pdf" } };
    await persistBrowserProxyResultFiles(result, [file(sourcePath, contents, "application/pdf")]);

    const savedPath = result.download.path;
    expect(path.dirname(savedPath)).toBe(path.join(tempHome.home, ".openclaw", "media", "browser"));
    expect(extractOriginalFilename(savedPath)).toBe(expectedFilename);
    expect(result.download.suggestedFilename).toBe("website-title.pdf");
    await expect(fs.readFile(savedPath, "utf8")).resolves.toBe(contents);
  });

  it("persists legitimate empty browser proxy downloads", async () => {
    const result = { path: "/tmp/empty-browser-download.bin" };
    await persistBrowserProxyResultFiles(result, [file(result.path, "", BINARY_MIME)]);

    const savedPath = result.path;
    expect(typeof savedPath).toBe("string");
    await expect(fs.stat(savedPath ?? "")).resolves.toMatchObject({ size: 0 });
    await expect(fs.readFile(savedPath ?? "")).resolves.toHaveLength(0);
  });

  it("rejects an oversized aggregate before persisting any files", async () => {
    const first = Buffer.alloc(MAX_FILE_BYTES, 0x41);
    const second = Buffer.alloc(MAX_TOTAL_FILE_BYTES - MAX_FILE_BYTES + 1, 0x42);

    await expectRejected(
      { downloads: [{ path: "/tmp/first.bin" }, { path: "/tmp/second.bin" }] },
      [file("/tmp/first.bin", first, BINARY_MIME), file("/tmp/second.bin", second, BINARY_MIME)],
      "browser proxy files exceed 16 MiB aggregate limit",
    );
  });

  it("rejects a file above the proxy per-file limit", async () => {
    const oversized = Buffer.alloc(MAX_FILE_BYTES + 1, 0x41);
    await expectRejected(
      { path: "/tmp/oversized.bin" },
      [file("/tmp/oversized.bin", oversized, BINARY_MIME)],
      "browser proxy file exceeds 10 MiB limit",
    );
  });

  it("rejects a later malformed file without persisting an earlier valid file", async () => {
    await expectRejected(
      {
        downloads: [
          { path: "/tmp/valid-browser-download.txt" },
          { path: "/tmp/malformed-browser-download.bin" },
        ],
      },
      [
        file("/tmp/valid-browser-download.txt", "valid browser download", "text/plain"),
        { path: "/tmp/malformed-browser-download.bin", base64: "ZE==" },
      ],
      "browser proxy file contains malformed base64 data",
    );
  });

  it("rejects too many files before persisting any", async () => {
    const files = Array.from({ length: 257 }, (_, index) =>
      file(`/tmp/file-${index}.bin`, "", BINARY_MIME),
    );

    await expectRejected(
      { downloads: files.map(({ path: filePath }) => ({ path: filePath })) },
      files,
      "browser proxy response exceeds 256 file limit",
    );
  });

  it.each([
    ["missing payload", "/node/missing.png", undefined],
    [
      "duplicate payload path",
      "/node/duplicate.png",
      [file("/node/duplicate.png"), file("/node/duplicate.png")],
    ],
    [
      "unreferenced extra payload",
      "/node/owned.png",
      [file("/node/owned.png"), file("/node/unowned.png")],
    ],
  ] as const)("rejects %s before persisting any files", async (_name, sourcePath, files) => {
    await expectRejected(
      { path: sourcePath },
      files,
      "browser proxy returned an invalid file envelope",
    );
  });

  it("rewrites a complete file mapping without traversing nested page data", async () => {
    const result = {
      ok: true,
      path: "/node/screenshot.png",
      imagePath: "/node/snapshot.png",
      download: { path: "/node/download.csv", suggestedFilename: "download.csv" },
      downloads: [
        { path: "/node/first.pdf", suggestedFilename: "first.pdf" },
        null,
        { path: 42 },
        { path: "/node/second.pdf", suggestedFilename: "second.pdf" },
        { path: "/node/first.pdf", suggestedFilename: "first-copy.pdf" },
      ],
      result: {
        path: "/node/page-controlled.txt",
        downloads: [{ path: "/node/page-controlled-download.txt" }],
      },
    };

    const routePaths = [
      "/node/screenshot.png",
      "/node/snapshot.png",
      "/node/download.csv",
      "/node/first.pdf",
      "/node/second.pdf",
    ];
    await persistBrowserProxyResultFiles(
      result,
      routePaths.map((filePath) => file(filePath, filePath)),
    );

    expect(result.path).not.toBe(routePaths[0]);
    expect(result.imagePath).not.toBe(routePaths[1]);
    expect(result.download.path).not.toBe(routePaths[2]);
    expect(result.downloads[0]?.path).not.toBe(routePaths[3]);
    expect(result.downloads[3]?.path).not.toBe(routePaths[4]);
    expect(result.downloads[4]?.path).toBe(result.downloads[0]?.path);
    expect(result.result).toEqual({
      path: "/node/page-controlled.txt",
      downloads: [{ path: "/node/page-controlled-download.txt" }],
    });
  });
});
