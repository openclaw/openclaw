/**
 * Tests read behavior and schema aliases in assembled coding tools.
 * Covers sandbox read guards, adaptive paging, and model-facing schema
 * normalization.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawReadTool, createSandboxedReadTool } from "./agent-tools.read.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlock = content.find((block) => {
    return (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    );
  }) as { text?: string } | undefined;
  return textBlock?.text ?? "";
}

describe("createOpenClawCodingTools read behavior", () => {
  it("applies sandbox path guards to canonical path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-"));
    const outsidePath = path.join(os.tmpdir(), "openclaw-outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      await expect(readTool.execute("sandbox-1", { path: outsidePath })).rejects.toThrow(
        /sandbox root/i,
      );
    } finally {
      await fs.rm(outsidePath, { force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-pages read output across chunks when context window budget allows", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-autopage-"));
    const filePath = path.join(tmpDir, "big.txt");
    const lines = Array.from(
      { length: 5000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 200_000,
      });
      const result = await readTool.execute("read-autopage-1", { path: "big.txt" });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("line-5000");
      expect(text).not.toContain("Read output capped at");
      expect(text).not.toMatch(/Use offset=\d+ to continue\.\]$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps inbound media refs to sandbox-staged media for reads", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-media-sbx-"));
    const mediaId = "webchat-upload.txt";
    const mediaPath = path.join(tmpDir, "media", "inbound", mediaId);
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, "sandbox media", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-media-sbx", {
        path: `media://inbound/${mediaId}`,
      });
      expect(extractToolText(result)).toContain("sandbox media");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("adds capped continuation guidance when aggregated read output reaches budget", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-cap-"));
    const filePath = path.join(tmpDir, "huge.txt");
    const lines = Array.from(
      { length: 8000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-cap-1", { path: "huge.txt" });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("[Read output capped at 32KB for this call. Use offset=");
      expect(text).not.toContain("line-8000");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses a smaller default read cap for small context windows", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-small-context-"));
    const filePath = path.join(tmpDir, "huge.txt");
    const lines = Array.from(
      { length: 8000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 16_000,
      });
      const result = await readTool.execute("read-small-context-cap", { path: "huge.txt" });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("line-0129");
      expect(text).toContain("Use offset=");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8 * 1024);
      expect(text).not.toContain("line-8000");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves explicit non-positive read limits with small context windows", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-small-context-limit-"));
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "alpha\nbeta\ngamma", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 16_000,
      });
      const result = await readTool.execute("read-small-context-explicit-limit", {
        path: "notes.txt",
        limit: -1,
      });

      expect(extractToolText(result)).toBe(
        "alpha\n\n[2 more lines in file. Use offset=2 to continue.]",
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("enforces the small-context read byte cap for long lines", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-small-context-long-"));
    const filePath = path.join(tmpDir, "huge.txt");
    const lines = Array.from(
      { length: 8000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}-${"x".repeat(220)}`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 16_000,
      });
      const result = await readTool.execute("read-small-context-long-line-cap", {
        path: "huge.txt",
      });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("[Read output capped at 8KB for this call. Use offset=");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8 * 1024);
      expect(text).not.toContain("line-0128");
      expect(text).not.toContain("line-8000");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves whitespace-only lines before capped continuation guidance", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-small-context-space-"));
    const filePath = path.join(tmpDir, "huge.txt");
    const whitespaceLines = Array.from({ length: 5000 }, () => "   ");
    await fs.writeFile(filePath, `${whitespaceLines.join("\n")}\nvisible`, "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 16_000,
      });
      const result = await readTool.execute("read-small-context-space-cap", {
        path: "huge.txt",
      });
      const text = extractToolText(result);
      const noticeIndex = text.indexOf("[Read output capped at 8KB");
      const emittedBeforeNotice = text.slice(0, noticeIndex);

      expect(noticeIndex).toBeGreaterThan(0);
      expect(emittedBeforeNotice).toMatch(/^ {3}\n/);
      expect(emittedBeforeNotice).toContain("\n   \n");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not advertise a later offset after capping an over-budget first line", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-small-context-line-"));
    await fs.writeFile(path.join(tmpDir, "huge.txt"), `line-0001-${"x".repeat(20_000)}`, "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 16_000,
      });
      const result = await readTool.execute("read-small-context-first-line-cap", {
        path: "huge.txt",
      });
      const text = extractToolText(result);
      expect(text).toContain("before line 1 because that line exceeds the budget");
      expect(text).toContain("Use offset=1 and limit=1 to read it explicitly.");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8 * 1024);
      expect(text).not.toContain("offset=2");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not loop on the same offset when a first line needs the full cap", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-small-context-full-"));
    await fs.writeFile(
      path.join(tmpDir, "huge.txt"),
      `${"x".repeat(8 * 1024 - 20)}\n${"y".repeat(200)}`,
      "utf8",
    );
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 16_000,
      });
      const result = await readTool.execute("read-small-context-full-line-cap", {
        path: "huge.txt",
      });
      const text = extractToolText(result);
      expect(text).toContain("before line 1 because that line leaves no room");
      expect(text).toContain("Use offset=1 and limit=1 to read it explicitly.");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8 * 1024);
      expect(text).not.toContain("Use offset=1 to continue.");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not treat continuation text in file content as pagination metadata", async () => {
    const content = "this is file content\n\n[1 more lines in file. Use offset=129 to continue.]";
    const execute = vi.fn(async (): Promise<AgentToolResult<unknown>> => {
      return {
        content: [
          {
            type: "text",
            text: content,
          },
        ],
        details: {},
      };
    });
    const readTool = createOpenClawReadTool(
      {
        name: "read",
        label: "read",
        description: "test read",
        parameters: Type.Object({
          path: Type.String(),
          offset: Type.Optional(Type.Number()),
          limit: Type.Optional(Type.Number()),
        }),
        execute,
      },
      { modelContextWindowTokens: 16_000 },
    );

    const result = await readTool.execute("read-content-offset-phrase", { path: "notes.txt" });

    expect(extractToolText(result)).toBe(content);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns empty content for explicit offsets beyond EOF", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-offset-eof-"));
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "one\ntwo\nthree", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-offset-limit", {
        path: "notes.txt",
        offset: 99,
        limit: 10,
      });

      expect(extractToolText(result)).toBe("");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty content for adaptive offsets beyond EOF", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-offset-adaptive-"));
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "one\ntwo\nthree\n", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-offset-adaptive", {
        path: "notes.txt",
        offset: 99,
      });

      expect(extractToolText(result)).toBe("");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns already-read adaptive content when pagination reaches EOF", async () => {
    const readResult: AgentToolResult<unknown> = {
      content: [
        {
          type: "text",
          text: "one\n\n[1 more lines in file. Use offset=2 to continue.]",
        },
      ],
      details: {
        truncation: {
          truncated: true,
          outputLines: 1,
          firstLineExceedsLimit: false,
        },
      },
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce(readResult)
      .mockRejectedValueOnce(new Error("Offset 2 is beyond end of file (1 lines total)"));
    const readTool = createOpenClawReadTool({
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
      }),
      execute,
    });

    const result = await readTool.execute("read-offset-paging-eof", {
      path: "notes.txt",
      offset: 1,
    });

    expect(extractToolText(result)).toBe("one");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps unrelated read failures loud", async () => {
    const readTool = createOpenClawReadTool({
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
      }),
      execute: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });

    await expect(
      readTool.execute("read-unrelated-error", {
        path: "notes.txt",
        offset: 99,
      }),
    ).rejects.toThrow("read failed");
  });

  it("strips truncation.content details from read results while preserving other fields", async () => {
    const readResult: AgentToolResult<unknown> = {
      content: [{ type: "text" as const, text: "line-0001" }],
      details: {
        truncation: {
          truncated: true,
          outputLines: 1,
          firstLineExceedsLimit: false,
          content: "hidden duplicate payload",
        },
      },
    };
    const baseRead: AgentTool = {
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      execute: vi.fn(async () => readResult),
    };

    const wrapped = createOpenClawReadTool(
      baseRead as unknown as Parameters<typeof createOpenClawReadTool>[0],
    );
    const result = await wrapped.execute("read-strip-1", { path: "demo.txt", limit: 1 });

    const details = (result as { details?: { truncation?: Record<string, unknown> } }).details;
    expect(details?.truncation?.truncated).toBe(true);
    expect(details?.truncation?.outputLines).toBe(1);
    expect(details?.truncation?.firstLineExceedsLimit).toBe(false);
    expect(details?.truncation).not.toHaveProperty("content");
  });
});
