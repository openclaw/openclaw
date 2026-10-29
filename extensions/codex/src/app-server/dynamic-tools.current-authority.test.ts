import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

vi.mock("openclaw/plugin-sdk/media-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-store")>();
  return { ...actual, saveMediaBuffer: vi.fn(actual.saveMediaBuffer) };
});

function makeTool(execute = vi.fn(async () => ({ content: [], details: {} }))): AnyAgentTool {
  return {
    name: "message",
    label: "Message",
    description: "Send a message",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute,
  };
}

const call = {
  threadId: "retained-thread",
  turnId: "current-turn",
  callId: "message-call",
  tool: "message",
  arguments: { action: "send", target: "test", media: "/remote/workspace/image.png" },
};

describe("retained declarations use current authority", () => {
  it("rejects revocation before argument preparation can read remote media", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const readRemote = vi.fn(async () => Buffer.from("image"));
    const assertCurrent = vi.fn(async () => {
      throw new Error("authority revoked");
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [makeTool(execute)],
      signal: new AbortController().signal,
      assertCurrentAsync: assertCurrent,
      hookContext: { workspaceDir: "/local/workspace", remoteWorkspaceRoot: "/remote/workspace" },
    });
    bridge.setRemoteWorkspaceFileReader?.(readRemote);
    const result = await bridge.handleToolCall(call);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.contentItems)).toContain("authority revoked");
    expect(readRemote).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rechecks revoked authority after a remote read before staging bytes", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    let current = true;
    const readRemote = vi.fn(async () => {
      current = false;
      return Buffer.from("image");
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [makeTool(execute)],
      signal: new AbortController().signal,
      assertCurrentAsync: async () => {
        if (!current) {
          throw new Error("authority revoked during read");
        }
      },
      hookContext: { workspaceDir: "/local/workspace", remoteWorkspaceRoot: "/remote/workspace" },
    });
    bridge.setRemoteWorkspaceFileReader?.(readRemote);
    vi.mocked(saveMediaBuffer).mockClear();
    const result = await bridge.handleToolCall(call);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.contentItems)).toContain("authority revoked during read");
    expect(readRemote).toHaveBeenCalledTimes(1);
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["description", "schema"] as const)("withholds a changed current %s", async (change) => {
    const accepted = createCodexDynamicToolBridge({
      tools: [makeTool()],
      signal: new AbortController().signal,
    });
    const current = makeTool();
    if (change === "description") {
      current.description = "A different contract";
    } else {
      current.parameters = { type: "object", properties: { required: { type: "string" } } };
    }
    const resumed = createCodexDynamicToolBridge({
      tools: [current],
      registeredSpecs: accepted.specs,
      requireExactRegisteredDefinitions: true,
      signal: new AbortController().signal,
    });
    expect(resumed.specs).toEqual(accepted.specs);
    expect(resumed.availableTools).toEqual([]);
    expect((await resumed.handleToolCall(call)).success).toBe(false);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("never substitutes a registered fallback for unavailable current authority", async () => {
    const fallback = makeTool();
    const accepted = createCodexDynamicToolBridge({
      tools: [fallback],
      signal: new AbortController().signal,
    });
    const resumed = createCodexDynamicToolBridge({
      tools: [],
      registeredFallbackTools: [fallback],
      registeredSpecs: accepted.specs,
      requireExactRegisteredDefinitions: true,
      signal: new AbortController().signal,
    });
    expect((await resumed.handleToolCall(call)).success).toBe(false);
    expect(fallback.execute).not.toHaveBeenCalled();
  });
});
