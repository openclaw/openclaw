import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createOpenClawReadTool } from "./pi-tools.read.js";

// 1x1 red PNG (minimal valid PNG)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

function makeFakeReadTool(result: AgentToolResult<unknown>): AnyAgentTool {
  return {
    name: "read",
    description: "Read files",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        file_path: { type: "string", description: "File path" },
      },
      required: [],
    },
    execute: vi.fn().mockResolvedValue(result),
  };
}

describe("createOpenClawReadTool image delivery", () => {
  let workspaceRoot: string;

  it("injects MEDIA: directive when reading an image with workspaceRoot", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-read-test-"));
    try {
      const imageResult: AgentToolResult<unknown> = {
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        ],
      };
      const baseTool = makeFakeReadTool(imageResult);
      const tool = createOpenClawReadTool(baseTool, workspaceRoot);

      const result = await tool.execute("call-1", { path: "./test.png" }, undefined as never);
      const content = result.content as Array<{ type: string; text?: string }>;
      const textBlock = content.find((b) => b.type === "text");

      expect(textBlock).toBeDefined();
      expect(textBlock!.text).toContain("MEDIA:");
      expect(textBlock!.text).toContain(".openclaw/media-cache/");
      expect(textBlock!.text).toContain(".png");

      // Verify the file was actually written
      const mediaMatch = textBlock!.text!.match(/MEDIA:\.\/(.+)/);
      expect(mediaMatch).toBeTruthy();
      const savedPath = join(workspaceRoot, mediaMatch![1]);
      const savedData = await readFile(savedPath);
      expect(savedData.length).toBeGreaterThan(0);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not inject MEDIA: directive when no workspaceRoot is provided", async () => {
    const imageResult: AgentToolResult<unknown> = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
    };
    const baseTool = makeFakeReadTool(imageResult);
    const tool = createOpenClawReadTool(baseTool);

    const result = await tool.execute("call-2", { path: "./test.png" }, undefined as never);
    const content = result.content as Array<{ type: string; text?: string }>;
    const textBlock = content.find((b) => b.type === "text");

    expect(textBlock).toBeDefined();
    expect(textBlock!.text).not.toContain("MEDIA:");
  });

  it("does not inject MEDIA: for non-image read results", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-read-test-"));
    try {
      const textResult: AgentToolResult<unknown> = {
        content: [{ type: "text", text: "hello world" }],
      };
      const baseTool = makeFakeReadTool(textResult);
      const tool = createOpenClawReadTool(baseTool, workspaceRoot);

      const result = await tool.execute("call-3", { path: "./test.txt" }, undefined as never);
      const content = result.content as Array<{ type: string; text?: string }>;
      const textBlock = content.find((b) => b.type === "text");

      expect(textBlock).toBeDefined();
      expect(textBlock!.text).not.toContain("MEDIA:");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
