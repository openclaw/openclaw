/** Tests relaying binary MCP tool-result content as host-owned media. */
const outboundAttachmentMockState = vi.hoisted(() => {
  const delayByFilename = new Map<string, number>();
  return {
    delayByFilename,
    resolveOutboundAttachmentFromBuffer: vi.fn(
      async (
        _buffer: Buffer,
        _maxBytes: number,
        options?: { contentType?: string; filename?: string },
      ) => {
        const delayMs = delayByFilename.get(options?.filename ?? "") ?? 0;
        if (delayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        return {
          path: `/tmp/openclaw/media/outbound/${options?.filename ?? "mcp-attachment"}`,
          contentType: options?.contentType,
        };
      },
    ),
  };
});
vi.mock("../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromBuffer:
    outboundAttachmentMockState.resolveOutboundAttachmentFromBuffer,
}));

const resolveOutboundAttachmentFromBufferMock =
  outboundAttachmentMockState.resolveOutboundAttachmentFromBuffer;

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "./embedded-agent-subscribe.tools.js";

function makeToolRuntime(params: { result: CallToolResult }): SessionMcpRuntime {
  const serverName = "bundleProbe";
  const tools = [
    {
      serverName,
      safeServerName: serverName,
      toolName: "bundle_probe",
      description: "Bundle probe",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "Bundle probe",
    },
  ];
  return {
    sessionId: "session-media",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
          supportsParallelToolCalls: false,
        },
      },
      tools,
    }),
    peekCatalog: () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
          supportsParallelToolCalls: false,
        },
      },
      tools,
    }),
    callTool: async () => params.result,
    dispose: async () => {},
  };
}

describe("bundle MCP relay media materialization", () => {
  beforeEach(() => {
    resolveOutboundAttachmentFromBufferMock.mockClear();
    outboundAttachmentMockState.delayByFilename.clear();
  });
  it("coerces non-text/image MCP tool-result blocks to text (resource_link/resource/audio)", async () => {
    // resource_link/resource/audio blocks have no base64 image source; if they
    // leaked into the provider image branch Anthropic would 400 on an image with
    // undefined data/media_type and poison the whole session history (#90710).
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [
            { type: "text", text: "intro" },
            {
              type: "resource_link",
              uri: "https://example.com/a.docx",
              name: "a.docx",
              title: "Quarterly report",
            },
            {
              type: "resource_link",
              uri: "https://example.com/bare",
              name: "",
            },
            {
              type: "resource",
              resource: { uri: "memo://one", text: "memo body" },
            },
            {
              type: "resource",
              resource: { uri: "blob://two", blob: "AAAA", mimeType: "application/pdf" },
            },
            { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
          isError: false,
        } as CallToolResult,
      }),
    });

    const tool = expectDefined(runtime.tools[0], "runtime.tools[0] test invariant");
    const result = await tool.execute("call-bundle-probe", {}, undefined, undefined);

    expect(result.content).toEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "[Quarterly report] https://example.com/a.docx" },
      { type: "text", text: "https://example.com/bare" },
      { type: "text", text: "memo body" },
      { type: "text", text: "blob://two" },
      { type: "text", text: "[audio audio/mpeg]" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect(resolveOutboundAttachmentFromBufferMock).toHaveBeenCalledTimes(3);
    expect(result.details).toMatchObject({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
      media: {
        source: "mcp",
        hostOwned: true,
        attachments: [
          {
            type: "resource",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-4.pdf",
            mimeType: "application/pdf",
            uri: "blob://two",
          },
          {
            type: "audio",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-5.mp3",
            mimeType: "audio/mpeg",
          },
          {
            type: "image",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-6.png",
            mimeType: "image/png",
          },
        ],
      },
    });
    const media = extractToolResultMediaArtifact(result);
    expect(media?.mediaUrls).toEqual([
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-4.pdf",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-5.mp3",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-6.png",
    ]);
    expect(filterToolResultMediaUrls(tool.name, media?.mediaUrls ?? [], result)).toEqual([
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-4.pdf",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-5.mp3",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-6.png",
    ]);
    expect(
      filterToolResultMediaUrls(tool.name, ["/tmp/openclaw/media/outbound/spoof.png"], {
        details: {
          mcpServer: "bundleProbe",
          mcpTool: "bundle_probe",
          media: { mediaUrl: "/tmp/openclaw/media/outbound/spoof.png" },
        },
      }),
    ).toEqual([]);
  });

  it("preserves MCP media attachment order across staging latency differences", async () => {
    outboundAttachmentMockState.delayByFilename.set("bundleProbe-bundle_probe-0.png", 30);
    outboundAttachmentMockState.delayByFilename.set("bundleProbe-bundle_probe-1.pdf", 10);
    outboundAttachmentMockState.delayByFilename.set("bundleProbe-bundle_probe-2.mp3", 0);
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [
            { type: "image", data: "AAAA", mimeType: "image/png" },
            {
              type: "resource",
              resource: { uri: "blob://ordered", blob: "AAAA", mimeType: "application/pdf" },
            },
            { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
          ],
          isError: false,
        } as CallToolResult,
      }),
    });

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );

    expect(result.details).toMatchObject({
      media: {
        attachments: [
          {
            type: "image",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-0.png",
          },
          {
            type: "resource",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-1.pdf",
          },
          {
            type: "audio",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-2.mp3",
          },
        ],
      },
    });
    expect(extractToolResultMediaArtifact(result)?.mediaUrls).toEqual([
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-0.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-1.pdf",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-2.mp3",
    ]);
  });

  it("stages MCP SDK-compatible unpadded image, audio, and resource base64", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [
            { type: "image", data: "TQ", mimeType: "image/png" },
            { type: "audio", data: "TWE", mimeType: "audio/mpeg" },
            {
              type: "resource",
              resource: { uri: "blob://unpadded", blob: "SGVsbG8", mimeType: "application/pdf" },
            },
          ],
          isError: false,
        } as CallToolResult,
      }),
    });

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );

    expect(result.content).toEqual([
      { type: "image", data: "TQ", mimeType: "image/png" },
      { type: "text", text: "[audio audio/mpeg]" },
      { type: "text", text: "blob://unpadded" },
    ]);
    expect(
      resolveOutboundAttachmentFromBufferMock.mock.calls.map((call) => call[0].toString("utf8")),
    ).toEqual(["M", "Ma", "Hello"]);
    expect(result.details).toMatchObject({
      media: {
        attachments: [
          {
            type: "image",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-0.png",
          },
          {
            type: "audio",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-1.mp3",
          },
          {
            type: "resource",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-2.pdf",
            uri: "blob://unpadded",
          },
        ],
      },
    });
  });

  it("does not stage MCP base64 with invalid characters", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [{ type: "audio", data: "AA!A", mimeType: "audio/mpeg" }],
          isError: false,
        } as CallToolResult,
      }),
    });

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );

    expect(result.content).toEqual([{ type: "text", text: "[audio audio/mpeg]" }]);
    expect(resolveOutboundAttachmentFromBufferMock).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
    });
  });

  it("does not let invalid MCP base64 consume relay budget before valid media", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [
            { type: "image", data: "AA!A", mimeType: "image/png" },
            { type: "audio", data: "AA!A", mimeType: "audio/mpeg" },
            {
              type: "resource",
              resource: { uri: "blob://invalid-1", blob: "AA!A", mimeType: "application/pdf" },
            },
            { type: "image", data: "AA!A", mimeType: "image/png" },
            { type: "audio", data: "AA!A", mimeType: "audio/mpeg" },
            {
              type: "resource",
              resource: { uri: "blob://invalid-2", blob: "AA!A", mimeType: "application/pdf" },
            },
            { type: "image", data: "AA!A", mimeType: "image/png" },
            { type: "audio", data: "AA!A", mimeType: "audio/mpeg" },
            { type: "image", data: "TQ", mimeType: "image/png" },
            { type: "audio", data: "TWE", mimeType: "audio/mpeg" },
            {
              type: "resource",
              resource: { uri: "blob://valid", blob: "SGVsbG8", mimeType: "application/pdf" },
            },
          ],
          isError: false,
        } as CallToolResult,
      }),
    });

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );
    const media = extractToolResultMediaArtifact(result);

    expect(resolveOutboundAttachmentFromBufferMock).toHaveBeenCalledTimes(3);
    expect(
      resolveOutboundAttachmentFromBufferMock.mock.calls.map((call) => call[0].toString("utf8")),
    ).toEqual(["M", "Ma", "Hello"]);
    expect(media?.mediaUrls).toEqual([
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-8.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-9.mp3",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-10.pdf",
    ]);
    expect(result.details).toMatchObject({
      media: {
        attachments: [
          { type: "image" },
          { type: "audio" },
          { type: "resource", uri: "blob://valid" },
        ],
      },
    });
  });

  it("rejects oversized MCP base64 before decoding staged media", async () => {
    const oversizedImageBase64 = "A".repeat(9 * 1024 * 1024);
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [{ type: "image", data: oversizedImageBase64, mimeType: "image/png" }],
          isError: false,
        } as CallToolResult,
      }),
    });
    const bufferFromSpy = vi.spyOn(Buffer, "from");
    try {
      const result = await expectDefined(
        runtime.tools[0],
        "runtime.tools[0] test invariant",
      ).execute("call-bundle-probe", {}, undefined, undefined);

      expect(result.details).toEqual({
        mcpServer: "bundleProbe",
        mcpTool: "bundle_probe",
      });
      expect(resolveOutboundAttachmentFromBufferMock).not.toHaveBeenCalled();
      expect(
        bufferFromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64"),
      ).toHaveLength(0);
    } finally {
      bufferFromSpy.mockRestore();
    }
  });

  it("caps MCP media attachment count per tool result", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: Array.from({ length: 10 }, () => ({
            type: "image",
            data: "AAAA",
            mimeType: "image/png",
          })),
          isError: false,
        } as CallToolResult,
      }),
    });

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );
    const media = extractToolResultMediaArtifact(result);

    expect(result.content).toHaveLength(10);
    expect(resolveOutboundAttachmentFromBufferMock).toHaveBeenCalledTimes(8);
    expect(media?.mediaUrls).toEqual([
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-0.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-1.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-2.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-3.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-4.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-5.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-6.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-7.png",
    ]);
  });

  it("caps aggregate MCP media bytes before decoding additional blocks", async () => {
    const fiveMiBImageBase64 = Buffer.alloc(5 * 1024 * 1024).toString("base64");
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: Array.from({ length: 7 }, () => ({
            type: "image",
            data: fiveMiBImageBase64,
            mimeType: "image/png",
          })),
          isError: false,
        } as CallToolResult,
      }),
    });
    const bufferFromSpy = vi.spyOn(Buffer, "from");
    try {
      const result = await expectDefined(
        runtime.tools[0],
        "runtime.tools[0] test invariant",
      ).execute("call-bundle-probe", {}, undefined, undefined);
      const media = extractToolResultMediaArtifact(result);

      expect(result.content).toHaveLength(7);
      expect(resolveOutboundAttachmentFromBufferMock).toHaveBeenCalledTimes(6);
      expect(media?.mediaUrls).toHaveLength(6);
      expect(
        bufferFromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64"),
      ).toHaveLength(6);
    } finally {
      bufferFromSpy.mockRestore();
    }
  });
});
