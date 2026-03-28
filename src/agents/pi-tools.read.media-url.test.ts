import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";

const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function createReadToolMock(returnImageContent: boolean): AnyAgentTool {
  return {
    name: "read",
    description: "Read file contents",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
    execute: async (toolCallId: string, args: Record<string, unknown>) => {
      const pathArg =
        args && typeof args === "object" && "path" in args ? (args as { path: string }).path : "";
      if (returnImageContent) {
        return {
          content: [
            { type: "text", text: `Read image file [image/png]` },
            { type: "image", data: TEST_IMAGE_BASE64, mimeType: "image/png" },
          ],
          details: {
            path: pathArg,
            truncation: { truncated: false },
          },
        } as AgentToolResult<unknown>;
      }
      return {
        content: [{ type: "text", text: "file content" }],
        details: { path: pathArg },
      } as AgentToolResult<unknown>;
    },
  } as unknown as AnyAgentTool;
}

async function loadModule() {
  return await import("./pi-tools.read.js");
}

describe("createOpenClawReadTool - media URL delivery", () => {
  it("adds details.media.mediaUrl when read tool returns image content", async () => {
    const { createOpenClawReadTool } = await loadModule();
    const mockTool = createReadToolMock(true);
    const wrapped = createOpenClawReadTool(mockTool);

    const result = await wrapped.execute("tc1", { path: "/workspace/test.png" });

    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const hasImageBlock = (result.content as Array<{ type?: unknown }>).some(
      (block) =>
        block && typeof block === "object" && (block as { type?: unknown }).type === "image",
    );
    expect(hasImageBlock).toBe(true);

    const details = (result as { details?: unknown }).details;
    expect(details).toBeDefined();
    expect(typeof details).toBe("object");
    const detailsRecord = details as Record<string, unknown>;
    expect(detailsRecord.media).toBeDefined();
    expect(typeof detailsRecord.media).toBe("object");
    const media = detailsRecord.media as Record<string, unknown>;
    expect(media.mediaUrl).toBe("/workspace/test.png");
  });

  it("does not add media URL when read tool returns text content only", async () => {
    const { createOpenClawReadTool } = await loadModule();
    const mockTool = createReadToolMock(false);
    const wrapped = createOpenClawReadTool(mockTool);

    const result = await wrapped.execute("tc2", { path: "/workspace/test.txt" });

    const details = (result as { details?: unknown }).details;
    expect(details).toBeDefined();
    const detailsRecord = details as Record<string, unknown>;
    expect(detailsRecord.media).toBeUndefined();
  });

  it("preserves existing details.media when adding mediaUrl", async () => {
    const { createOpenClawReadTool } = await loadModule();

    const mockToolWithExistingMedia: AnyAgentTool = {
      name: "read",
      description: "Read file contents",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      execute: async () => {
        return {
          content: [
            { type: "text", text: `Read image file [image/png]` },
            { type: "image", data: TEST_IMAGE_BASE64, mimeType: "image/png" },
          ],
          details: {
            path: "/workspace/test.png",
            media: {
              audioAsVoice: true,
              customField: "customValue",
            },
          },
        } as AgentToolResult<unknown>;
      },
    } as unknown as AnyAgentTool;

    const wrapped = createOpenClawReadTool(mockToolWithExistingMedia);
    const result = await wrapped.execute("tc3", { path: "/workspace/test.png" });

    const details = (result as { details?: unknown }).details as
      | Record<string, unknown>
      | undefined;
    expect(details).toBeDefined();
    const media = details?.media as Record<string, unknown> | undefined;
    expect(media).toBeDefined();
    expect(media?.mediaUrl).toBe("/workspace/test.png");
    expect(media?.audioAsVoice).toBe(true);
    expect(media?.customField).toBe("customValue");
  });
});
