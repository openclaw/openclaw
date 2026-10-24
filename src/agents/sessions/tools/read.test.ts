import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  resolveFileMutationQueueKey,
  withFileMutationQueueKeyResolution,
} from "./file-mutation-queue.js";
import { readRenderContext } from "./read-render.test-support.js";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.js";
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
const PNG_BYTES = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
const IMAGE_OPTIONS = { autoResizeImages: false };

const ONE_PIXEL_BMP = Buffer.from(
  "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==",
  "base64",
);

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

function memoryRead(content: string | Buffer, detectImageMimeType?: () => Promise<null>) {
  const buffer = typeof content === "string" ? Buffer.from(content) : content;
  return createReadToolDefinition("/workspace", {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(buffer),
      ...(detectImageMimeType ? { detectImageMimeType } : {}),
    },
  });
}

async function fileFixture(name: string, content: string | Buffer, options?: ReadToolOptions) {
  const tempDir = tempDirs.make("openclaw-read-");
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, content);
  return { tempDir, filePath, tool: createReadToolDefinition(tempDir, options) };
}

async function expectReadText(
  tool: ReturnType<typeof createReadToolDefinition>,
  args: Parameters<typeof tool.execute>[1],
  expected: string,
) {
  expect(textContent(await executeRead(tool, args))).toBe(expected);
}

async function queuedRead(tempDir: string, writePath: string, readPath: string, content: string) {
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
    { path: writePath, content },
    undefined,
  );
  const reader = createReadToolDefinition(tempDir, {
    operations: { access: readAccess, readFile: async (file) => await fs.readFile(file) },
  });
  const readResult = executeRead(reader, { path: readPath });
  void readResult.catch(() => {});
  await nextTurn();
  expect(readAccess).not.toHaveBeenCalled();
  releaseBlocker.resolve();
  await blocker;
  const [, result] = await Promise.all([writeResult, readResult]);
  return { result, readAccess };
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
    const stateDir = tempDirs.make("openclaw-read-media-");
    const mediaId = `read-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const mediaPath = path.join(stateDir, "media", "inbound", mediaId);
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, PNG_BYTES);
    const tool = createReadToolDefinition("/workspace", IMAGE_OPTIONS);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const result = await executeRead(tool, { path: `media://inbound/${mediaId}` });

      expect(result.content).toStrictEqual([
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: ONE_PIXEL_PNG_BASE64, mimeType: "image/png" },
      ]);
    });
  });

  it("omits images for a non-vision extension model", async () => {
    const { tool, filePath } = await fileFixture("pixel.png", PNG_BYTES, IMAGE_OPTIONS);
    const result = await tool.execute("extension-read", { path: filePath }, undefined, undefined, {
      model: { input: ["text"] },
    } as never);
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(0);
    expect(textContent(result)).toContain("does not support images");
  });

  it("converts BMP files to PNG attachments", async () => {
    const { tool, filePath } = await fileFixture("pixel.bmp", ONE_PIXEL_BMP, IMAGE_OPTIONS);
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
    const { tempDir, tool: local } = await fileFixture("file.txt", "present");
    const missing = await executeRead(local, { path: "file.txt/child", optional: true });
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
    await expect(executeRead(denied, { path: "secret.txt", optional: true })).rejects.toThrow(
      "permission denied",
    );
  });

  it.runIf(process.platform !== "win32")("rejects FIFOs without a writer", async () => {
    const tempDir = tempDirs.make("openclaw-read-fifo-");
    const fifoPath = path.join(tempDir, "live.pipe");
    expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);
    const tool = createReadToolDefinition(tempDir);
    const read = executeRead(tool, { path: fifoPath });
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
      const writerExit = once(writer, "exit");
      await Promise.race([read.catch(() => undefined), delay(2_000)]);
      writer.kill("SIGKILL");
      await writerExit;
    }

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: { message: expect.stringMatching(/regular file/i) },
    });
  });

  it("describes empty files instead of returning blank content", async () => {
    const { tool } = await fileFixture("empty.txt", "");
    await expectReadText(tool, { path: "empty.txt" }, "File is empty (0 bytes).");
  });

  it("reads later lines from isolated files larger than 16 MiB", async () => {
    const { tool, filePath } = await fileFixture(
      "large.sqlite",
      `${"x".repeat(17 * 1024 * 1024)}\nlast line\n`,
    );
    await expectReadText(tool, { path: filePath, offset: 2 }, "last line\n");
  });

  it("reports the byte count when a BOM-only file decodes to empty text", async () => {
    const tool = memoryRead(Buffer.from([0xef, 0xbb, 0xbf]));
    await expectReadText(tool, { path: "bom.txt" }, "File contains no readable text (3 bytes).");
  });

  it("does not decode PDF bytes from a renamed .bin file", async () => {
    const { tool } = await fileFixture(
      "pdf.bin",
      Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF", "ascii"),
    );
    const result = await executeRead(tool, { path: "pdf.bin" });
    expect(textContent(result)).toMatch(
      /^Read did not return file contents because it detected a binary document \[.+\]\. Use an available document parser or converter, or convert the file to text, Markdown, or CSV, then read the converted file\.$/,
    );
    expect(result.details.kind).toBe("text");
    expect(decodeWindowsTextFileBufferMock).not.toHaveBeenCalled();
  });

  it("counts filename-resolution notes inside the complete 50 KiB read ceiling", async () => {
    const { tool } = await fileFixture(
      "re\u0301sume\u0301 3.04\u202fPM d\u2019accord.txt",
      "x".repeat(DEFAULT_MAX_BYTES),
    );
    const result = await executeRead(tool, { path: "r\u00e9sum\u00e9 3.04 PM d'accord.txt" });
    expect(textContent(result)).toContain("Resolved filename");
    expect(textContent(result)).toContain("cursor=");
    expect(Buffer.byteLength(textContent(result), "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });

  it("refuses ambiguous Unicode-equivalent filenames", async () => {
    const { tempDir, tool } = await fileFixture("d'accord.txt", "straight");
    await fs.writeFile(path.join(tempDir, "d\u2019accord.txt"), "curly");
    await expect(executeRead(tool, { path: "d\u2018accord.txt" })).rejects.toThrow(
      /ambiguous.*d'accord\.txt.*d\u2019accord\.txt/i,
    );
  });

  it("suggests a close filename without reading it", async () => {
    const { tool } = await fileFixture("AGENTS.md", "instructions");
    await expect(executeRead(tool, { path: "AGENT.md" })).rejects.toThrow(
      /Did you mean: AGENTS\.md\?/,
    );
  });

  it("continues an oversized astral emoji line without splitting characters", async () => {
    const text = `prefix${"🦞".repeat(DEFAULT_MAX_BYTES)}`;
    const tool = memoryRead(text, async () => null);
    let reconstructed = "";
    let cursor: number | undefined;
    for (let page = 0; page < 12; page += 1) {
      const args = { path: "generated.json", ...(cursor === undefined ? {} : { cursor }) };
      const result = await executeRead(tool, args);
      const output = textContent(result);
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(output).not.toMatch(/\b(?:bash|sed|head)\b/);
      if (result.details.kind !== "truncated") {
        reconstructed += output;
        break;
      }
      const continuation = result.details.continuation;
      expect(continuation).toMatchObject({ kind: "cursor", offset: 1 });
      if (continuation.kind !== "cursor") {
        throw new Error("Expected an intra-line cursor");
      }
      expect(continuation.cursor).toBeGreaterThan(cursor ?? 0);
      expect(output).toContain(`offset=1, cursor=${continuation.cursor}`);
      reconstructed += output.replace(/\n\n\[Showing[^\]]*\]$/, "");
      cursor = continuation.cursor;
    }
    expect(reconstructed).toBe(text);
  });

  it("rejects an intra-line cursor inside a UTF-16 surrogate pair", async () => {
    const tool = memoryRead("a🦞b");
    await expect(executeRead(tool, { path: "emoji.txt", cursor: 2 })).rejects.toThrow(
      /cursor.*surrogate.*(?:1|3)/i,
    );
  });

  it("explains an intra-line cursor past EOF", async () => {
    const tool = memoryRead("done");
    await expectReadText(
      tool,
      { path: "done.txt", cursor: 5 },
      "Cursor 5 is at or beyond the end of line 1 (4 characters).",
    );
  });

  it.each<[number, string]>([
    [2000, "File contains 2 blank lines."],
    [
      1,
      "Selected range contains 1 blank line.\n\n[1 more line in file. Use offset=2 to continue.]",
    ],
  ])("accepts cursor 0 on blank input (limit=%s)", async (limit, expected) => {
    const { tempDir } = await fileFixture("synthetic.txt", "\n\n");
    const result = await createReadTool(tempDir).execute("read-zero", {
      path: "synthetic.txt",
      offset: 1,
      limit,
      cursor: 0,
    });
    expect(textContent(result)).toBe(expected);
  });

  it("finishes an oversized selected line before continuing at the next line", async () => {
    const longLine = "x".repeat(DEFAULT_MAX_BYTES + 100);
    const tool = memoryRead(`before\n${longLine}\nafter`);
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
    const tool = memoryRead("alpha\nbeta\ngamma", async () => null);
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

  it("renders sanitized text and a visible fallback when inline images are hidden", () => {
    const tool = createReadToolDefinition("/workspace");
    const component = tool.renderResult?.(
      {
        content: [
          { type: "text", text: "alpha\u0000\r\n" },
          { type: "image", data: ONE_PIXEL_PNG_BASE64, mimeType: "image/png" },
          { type: "text", text: "beta\tend" },
        ],
        details: { kind: "text", content: "alpha\u0000\r\n\nbeta\tend" },
      },
      { expanded: true, isPartial: false },
      plainTheme,
      readRenderContext("notes.txt"),
    );
    expect(
      component
        ?.render(120)
        .map((line) => line.trimEnd())
        .join("\n")
        .trim(),
    ).toBe("alpha\\x00\n\nbeta   end\n[Image: [image/png] 1x1]");
  });

  it("rejects offset zero before accessing the file", async () => {
    const access = vi.fn(async () => {});
    const detectImageMimeType = vi.fn(async () => null);
    const readFile = vi.fn(async () => Buffer.from("alpha\nbeta\ngamma"));
    const operations = { access, detectImageMimeType, readFile };
    const tool = createReadToolDefinition("/workspace", { operations });
    await expect(
      executeRead(tool, { path: "notes.txt", offset: 0, optional: true }),
    ).rejects.toThrow("Offset must be an integer at least 1");
    expect(access).not.toHaveBeenCalled();
    expect(detectImageMimeType).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("uses the shared Windows decoder for local filesystem reads", async () => {
    const legacyBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    decodeWindowsTextFileBufferMock.mockReturnValueOnce("decoded legacy text");
    const { tool } = await fileFixture("legacy.txt", legacyBytes);
    const result = await executeRead(tool, { path: "legacy.txt" });
    expect(decodeWindowsTextFileBufferMock).toHaveBeenCalledWith({ buffer: legacyBytes });
    expect(textContent(result)).toBe("decoded legacy text");
  });

  it("waits for an aliased queued write before reading the same new file", async () => {
    const tempDir = tempDirs.make("openclaw-read-write-order-");
    const realDir = path.join(tempDir, "real");
    const aliasDir = path.join(tempDir, "alias");
    await fs.mkdir(realDir);
    await fs.symlink(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const writePath = path.join(aliasDir, "race-target.txt");
    const readPath = path.join(realDir, "race-target.txt");
    const { result, readAccess } = await queuedRead(tempDir, writePath, readPath, "first snapshot");
    expect(readAccess).toHaveBeenCalledOnce();
    expect(textContent(result)).toBe("first snapshot");
  });

  it("queues every accepted Unicode spelling before reading a new file", async () => {
    const tempDir = tempDirs.make("openclaw-read-unicode-order-");
    const writePath = path.join(tempDir, "caf\u00e9.txt");
    const readPath = path.join(tempDir, "cafe\u0301.txt");
    const { result, readAccess } = await queuedRead(
      tempDir,
      writePath,
      readPath,
      "normalized snapshot",
    );
    expect(readAccess).toHaveBeenCalled();
    expect(textContent(result)).toContain("normalized snapshot");
  });
});
