// Read tool tests cover bounded file reads and safe, actionable continuation.
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  resolveFileMutationQueueKey,
  withFileMutationQueueKeyResolution,
} from "./file-mutation-queue.js";
import { createReadTool, createReadToolDefinition } from "./read.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.js";
import { createWriteTool } from "./write.js";

const decodeWindowsTextFileBufferMock = vi.hoisted(() =>
  vi.fn(({ buffer }: { buffer: Buffer }) => buffer.toString("utf8")),
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../../infra/windows-encoding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/windows-encoding.js")>()),
  decodeWindowsTextFileBuffer: decodeWindowsTextFileBufferMock,
}));

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createTinyBmp(): Buffer {
  const buffer = Buffer.alloc(58);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(1, 18);
  buffer.writeInt32LE(1, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(4, 34);
  buffer[56] = 0xff;
  return buffer;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function executeRead(
  tool: ReturnType<typeof createReadToolDefinition>,
  args: Parameters<typeof tool.execute>[1],
) {
  return tool.execute("read", args, undefined, undefined, {} as never);
}

const plainTheme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function renderReadCall(args: { path: string; offset?: number; limit?: number }): string {
  const tool = createReadToolDefinition("/workspace");
  const component = tool.renderCall?.(args, plainTheme, {
    lastComponent: undefined,
    expanded: true,
    cwd: "/workspace",
  } as never);
  return component?.render(120).join("\n").trimEnd() ?? "";
}

describe("read tool", () => {
  beforeEach(() => {
    decodeWindowsTextFileBufferMock.mockReset();
    decodeWindowsTextFileBufferMock.mockImplementation(({ buffer }) => buffer.toString("utf8"));
  });

  it("reads managed inbound media refs as image files", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-media-"));
    const mediaId = `read-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const mediaPath = path.join(stateDir, "media", "inbound", mediaId);
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

    const tool = createReadToolDefinition("/workspace", { autoResizeImages: false });
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const result = await executeRead(tool, { path: `media://inbound/${mediaId}` });

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

  it.each(["extension", "embedded"])("omits images for a non-vision %s model", async (source) => {
    const stateDir = tempDirs.make("openclaw-read-vision-");
    const imagePath = path.join(stateDir, "pixel.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

    const result =
      source === "embedded"
        ? await createReadTool(stateDir, {
            autoResizeImages: false,
            modelHasVision: false,
          }).execute("embedded-read", { path: imagePath })
        : await createReadToolDefinition(stateDir, { autoResizeImages: false }).execute(
            "extension-read",
            { path: imagePath },
            undefined,
            undefined,
            {
              model: { input: ["text"] },
            } as never,
          );
    const imageParts = result.content.filter((part) => part.type === "image");
    expect(imageParts).toHaveLength(0);
    expect(textContent(result)).toContain("does not support images");
  });

  it("converts BMP files to PNG attachments", async () => {
    const tempDir = tempDirs.make("openclaw-read-bmp-");
    const filePath = path.join(tempDir, "pixel.bmp");
    await fs.writeFile(filePath, createTinyBmp());
    const tool = createReadToolDefinition(tempDir, { autoResizeImages: false });
    const result = await executeRead(tool, { path: filePath });

    expect(textContent(result)).toContain("Read image file [image/png]");
    expect(textContent(result)).toContain("converted from image/bmp to image/png");
    const image = result.content.find((part) => part.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(image?.type === "image" ? image.data : "", "base64").subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("explains that directory paths must be listed before reading a file", async () => {
    const tempDir = tempDirs.make("openclaw-read-directory-");
    const tool = createReadToolDefinition(tempDir);

    await expect(executeRead(tool, { path: ".", optional: true })).rejects.toThrow(
      "Read requires a file path, but . is a directory. List the directory, then read a specific file.",
    );
  });

  it("treats ENOTDIR as optional not_found without swallowing permission errors", async () => {
    const tempDir = tempDirs.make("openclaw-read-enotdir-");
    await fs.writeFile(path.join(tempDir, "file.txt"), "present");
    const local = createReadToolDefinition(tempDir);
    const missing = await local.execute(
      "call-optional-enotdir",
      { path: "file.txt/child", optional: true },
      undefined,
      undefined,
      {} as never,
    );
    expect(missing.details).toEqual({
      kind: "not_found",
      status: "not_found",
      path: "file.txt/child",
      optional: true,
    });

    const denied = createReadToolDefinition(tempDir, {
      operations: {
        access: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
        readFile: async () => Buffer.from("unreachable"),
      },
    });
    await expect(
      denied.execute(
        "call-optional-denied",
        { path: "secret.txt", optional: true },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("permission denied");
  });

  it.runIf(process.platform !== "win32")(
    "refuses a FIFO without waiting for a writer",
    async () => {
      const tempDir = tempDirs.make("openclaw-read-fifo-");
      const fifoPath = path.join(tempDir, "live.pipe");
      expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);
      const tool = createReadToolDefinition(tempDir);
      const read = tool.execute("call-fifo", { path: fifoPath }, undefined, undefined, {} as never);
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        read.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), 1_000);
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }

      if (outcome.kind === "timeout") {
        const writer = spawn(
          "/bin/sh",
          ["-c", 'while :; do printf x > "$1"; done', "openclaw-read-fifo", fifoPath],
          { stdio: "ignore" },
        );
        const writerExit = new Promise<void>((resolve) => {
          writer.once("exit", () => resolve());
        });
        await Promise.race([
          read.catch(() => undefined),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2_000);
          }),
        ]);
        writer.kill("SIGKILL");
        await writerExit;
      }

      expect(outcome).toMatchObject({
        kind: "rejected",
        error: { message: expect.stringMatching(/regular file/i) },
      });
    },
  );

  it("describes empty files instead of returning blank content", async () => {
    const tempDir = tempDirs.make("openclaw-read-empty-");
    await fs.writeFile(path.join(tempDir, "empty.txt"), "");
    const tool = createReadToolDefinition(tempDir);

    const result = await executeRead(tool, { path: "empty.txt" });

    expect(textContent(result)).toBe("File is empty (0 bytes).");
  });

  it("reads later lines from isolated files larger than 16 MiB", async () => {
    const tempDir = tempDirs.make("openclaw-read-large-");
    const filePath = path.join(tempDir, "large.sqlite");
    await fs.writeFile(filePath, `${"x".repeat(17 * 1024 * 1024)}\nlast line\n`);

    const result = await executeRead(createReadToolDefinition(tempDir), {
      path: filePath,
      offset: 2,
    });

    expect(textContent(result)).toBe("last line\n");
  });

  it("reports the byte count when a BOM-only file decodes to empty text", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from([0xef, 0xbb, 0xbf]),
      },
    });

    const result = await executeRead(tool, { path: "bom.txt" });

    expect(textContent(result)).toBe("File contains no readable text (3 bytes).");
  });

  it("does not decode PDF bytes from a renamed .bin file", async () => {
    const tempDir = tempDirs.make("openclaw-read-document-");
    await fs.writeFile(
      path.join(tempDir, "pdf.bin"),
      Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF", "ascii"),
    );
    const result = await executeRead(createReadToolDefinition(tempDir), { path: "pdf.bin" });

    expect(textContent(result)).toMatch(
      /^Read did not return file contents because it detected a binary document \[.+\]\. Use an available document parser or converter, or convert the file to text, Markdown, or CSV, then read the converted file\.$/,
    );
    expect(result.details.kind).toBe("text");
    expect(decodeWindowsTextFileBufferMock).not.toHaveBeenCalled();
  });

  it("counts filename-resolution notes inside the complete 50 KiB read ceiling", async () => {
    const tempDir = tempDirs.make("openclaw-read-unicode-budget-");
    const storedName = "re\u0301sume\u0301 3.04\u202fPM d\u2019accord.txt";
    await fs.writeFile(path.join(tempDir, storedName), "x".repeat(DEFAULT_MAX_BYTES));
    const tool = createReadToolDefinition(tempDir);

    const result = await executeRead(tool, { path: "r\u00e9sum\u00e9 3.04 PM d'accord.txt" });

    expect(textContent(result)).toContain("Resolved filename");
    expect(textContent(result)).toContain("cursor=");
    expect(Buffer.byteLength(textContent(result), "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });

  it("refuses ambiguous Unicode-equivalent filenames", async () => {
    const tempDir = tempDirs.make("openclaw-read-unicode-ambiguous-");
    await fs.writeFile(path.join(tempDir, "d'accord.txt"), "straight");
    await fs.writeFile(path.join(tempDir, "d\u2019accord.txt"), "curly");
    const tool = createReadToolDefinition(tempDir);

    await expect(executeRead(tool, { path: "d\u2018accord.txt" })).rejects.toThrow(
      /ambiguous.*d'accord\.txt.*d\u2019accord\.txt/i,
    );
  });

  it("suggests a close filename without reading it", async () => {
    const tempDir = tempDirs.make("openclaw-read-suggestion-");
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), "instructions");
    const tool = createReadToolDefinition(tempDir);

    await expect(
      tool.execute("call-suggestion", { path: "AGENT.md" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/Did you mean: AGENTS\.md\?/);
  });

  it("continues an oversized astral emoji line without splitting characters", async () => {
    const text = `prefix${"🦞".repeat(DEFAULT_MAX_BYTES)}`;
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from(text),
      },
    });

    let reconstructed = "";
    let cursor: number | undefined;
    for (let page = 0; page < 12; page += 1) {
      const args = { path: "generated.json", ...(cursor === undefined ? {} : { cursor }) };
      const result = await tool.execute(`call-${page}`, args, undefined, undefined, {} as never);
      const output = textContent(result);
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(output).not.toMatch(/\b(?:bash|sed|head)\b/);
      if (result.details.kind !== "truncated") {
        reconstructed += output;
        break;
      }
      const continuation = (
        result.details as { continuation?: { kind: string; offset: number; cursor: number } }
      ).continuation;
      expect(continuation).toMatchObject({ kind: "cursor", offset: 1 });
      expect(continuation?.cursor).toBeGreaterThan(cursor ?? 0);
      expect(output).toContain(`offset=1, cursor=${continuation?.cursor}`);
      reconstructed += output.replace(/\n\n\[Showing[^\]]*\]$/, "");
      cursor = continuation?.cursor;
    }

    expect(reconstructed).toBe(text);
  });

  it("rejects an intra-line cursor inside a UTF-16 surrogate pair", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("a🦞b"),
      },
    });

    await expect(executeRead(tool, { path: "emoji.txt", cursor: 2 })).rejects.toThrow(
      /cursor.*surrogate.*(?:1|3)/i,
    );
  });

  it("explains an intra-line cursor past EOF", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("done"),
      },
    });

    const result = await executeRead(tool, { path: "done.txt", cursor: 5 });

    expect(textContent(result)).toBe("Cursor 5 is at or beyond the end of line 1 (4 characters).");
  });

  it.each([
    {
      name: "a blank-only file",
      contents: "\n\n",
      offset: 1,
      limit: 2000,
      expected: "File contains 2 blank lines.",
    },
    {
      name: "a blank-only range",
      contents: "\n\n",
      offset: 1,
      limit: 1,
      expected:
        "Selected range contains 1 blank line.\n\n[1 more line in file. Use offset=2 to continue.]",
    },
  ])("accepts cursor 0 on $name", async ({ contents, offset, limit, expected }) => {
    const tempDir = tempDirs.make("openclaw-read-cursor-zero-");
    await fs.writeFile(path.join(tempDir, "synthetic.txt"), contents);
    const result = await createReadTool(tempDir).execute("read-zero", {
      path: "synthetic.txt",
      offset,
      limit,
      cursor: 0,
    });

    expect(textContent(result)).toBe(expected);
  });

  it("finishes an oversized selected line before continuing at the next line", async () => {
    const longLine = "x".repeat(DEFAULT_MAX_BYTES + 100);
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from(`before\n${longLine}\nafter`),
      },
    });

    const first = await executeRead(tool, { path: "lines.txt", offset: 2, limit: 1 });
    const continuation = (
      first.details as { continuation?: { kind: string; offset: number; cursor: number } }
    ).continuation;
    expect(continuation).toMatchObject({ kind: "cursor", offset: 2 });

    const second = await executeRead(tool, {
      path: "lines.txt",
      offset: 2,
      cursor: continuation?.cursor,
      limit: 1,
    });
    if (first.details.kind !== "truncated" || second.details.kind !== "truncated") {
      throw new Error("Expected both partial pages to retain their continuation");
    }
    expect(first.details.content + second.details.content).toBe(longLine);
    expect(textContent(second)).toContain("offset=3");
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

    const result = await executeRead(tool, { path: "notes.txt", limit: -1 });

    expect(textContent(result)).toBe("alpha\n\n[2 more lines in file. Use offset=2 to continue.]");
    expect(result.details).toMatchObject({
      kind: "truncated",
      content: "alpha",
      continuation: { kind: "line", offset: 2, limit: 1 },
    });
  });

  it("normalizes an infinite rendered line limit", () => {
    expect(renderReadCall({ path: "notes.txt", limit: Number.POSITIVE_INFINITY })).toBe(
      `read notes.txt:1-${DEFAULT_MAX_LINES}`,
    );
  });

  it("rejects offset zero before accessing the file", async () => {
    const access = vi.fn(async () => {});
    const detectImageMimeType = vi.fn(async () => null);
    const readFile = vi.fn(async () => Buffer.from("alpha\nbeta\ngamma"));
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access,
        detectImageMimeType,
        readFile,
      },
    });

    await expect(
      executeRead(tool, { path: "notes.txt", offset: 0, optional: true }),
    ).rejects.toThrow("Offset must be an integer at least 1");
    expect(access).not.toHaveBeenCalled();
    expect(detectImageMimeType).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("uses the shared Windows decoder for local filesystem reads", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-encoding-"));
    const filePath = path.join(tempDir, "legacy.txt");
    const legacyBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    decodeWindowsTextFileBufferMock.mockReturnValueOnce("decoded legacy text");

    try {
      await fs.writeFile(filePath, legacyBytes);
      const tool = createReadToolDefinition(tempDir);
      const result = await executeRead(tool, { path: "legacy.txt" });

      expect(decodeWindowsTextFileBufferMock).toHaveBeenCalledWith({ buffer: legacyBytes });
      expect(textContent(result)).toBe("decoded legacy text");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for an aliased queued write before reading the same new file", async () => {
    const tempDir = tempDirs.make("openclaw-read-write-order-");
    const realDir = path.join(tempDir, "real");
    const aliasDir = path.join(tempDir, "alias");
    await fs.mkdir(realDir);
    await fs.symlink(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const writePath = path.join(aliasDir, "race-target.txt");
    const readPath = path.join(realDir, "race-target.txt");
    const blockerStarted = createDeferred();
    const releaseBlocker = createDeferred();
    const readAccess = vi.fn(async (absolutePath: string) => await fs.access(absolutePath));
    const blocker = withFileMutationQueueKeyResolution(
      resolveFileMutationQueueKey(writePath),
      async () => {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      },
    );
    await blockerStarted.promise;
    const writeResult = createWriteTool(tempDir).execute(
      "write",
      { path: writePath, content: "first snapshot" },
      undefined,
    );
    const readResult = createReadToolDefinition(tempDir, {
      operations: {
        access: readAccess,
        readFile: async (absolutePath) => await fs.readFile(absolutePath),
      },
    }).execute("read", { path: readPath }, undefined, undefined, {} as never);
    void readResult.catch(() => {});
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(readAccess).not.toHaveBeenCalled();

    releaseBlocker.resolve();
    await blocker;
    const [, result] = await Promise.all([writeResult, readResult]);
    expect(readAccess).toHaveBeenCalledOnce();
    expect(textContent(result)).toBe("first snapshot");
  });

  it("queues every accepted Unicode spelling before reading a new file", async () => {
    const tempDir = tempDirs.make("openclaw-read-unicode-order-");
    const writePath = path.join(tempDir, "caf\u00e9.txt");
    const readPath = path.join(tempDir, "cafe\u0301.txt");
    const blockerStarted = createDeferred();
    const releaseBlocker = createDeferred();
    const blocker = withFileMutationQueueKeyResolution(
      resolveFileMutationQueueKey(writePath),
      async () => {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      },
    );
    await blockerStarted.promise;

    const writeResult = createWriteTool(tempDir).execute(
      "write",
      { path: writePath, content: "normalized snapshot" },
      undefined,
    );
    const readAccess = vi.fn(async (absolutePath: string) => await fs.access(absolutePath));
    const readResult = createReadToolDefinition(tempDir, {
      operations: {
        access: readAccess,
        readFile: async (absolutePath) => await fs.readFile(absolutePath),
      },
    }).execute("read", { path: readPath }, undefined, undefined, {} as never);
    void readResult.catch(() => {});
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(readAccess).not.toHaveBeenCalled();

    releaseBlocker.resolve();
    await blocker;
    const [, result] = await Promise.all([writeResult, readResult]);
    expect(readAccess).toHaveBeenCalled();
    expect(textContent(result)).toContain("normalized snapshot");
  });
});
