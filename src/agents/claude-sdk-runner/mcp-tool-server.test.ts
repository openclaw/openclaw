/**
 * MCP Tool Server Contract Tests
 *
 * Derived from: implementation-plan.md Section 4.3 (In-Process MCP Tool Server,
 * before_tool_call preservation, concurrent tool calls), test-specifications.md
 * Sections 2.1 (registration) and 2.2 (tool lifecycle events).
 *
 * These tests verify that:
 * - createClaudeSdkMcpToolServer registers tools with correct names/descriptions/schemas
 * - Tool lifecycle events are emitted in start → [update]* → end order
 * - Concurrent tool calls maintain per-tool ordering guarantees
 * - Errors produce tool_execution_end with error field and MCP { isError: true }
 */

import { Type } from "@sinclair/typebox";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Capture the handler functions registered via tool()
// ---------------------------------------------------------------------------

type McpToolDef = {
  name: string;
  description: string;
  schema: unknown;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};

type McpServerConfig = {
  name: string;
  version: string;
  tools: McpToolDef[];
};

let capturedServer: McpServerConfig | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    createSdkMcpServer: vi.fn((config: McpServerConfig) => {
      capturedServer = config;
      return { type: "mock-mcp-server", ...config };
    }),
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: unknown,
        handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
      ): McpToolDef => ({ name, description, schema, handler }),
    ),
  };
});

// ---------------------------------------------------------------------------
// Import after mock setup
// ---------------------------------------------------------------------------

import type { EmbeddedPiSubscribeEvent } from "../pi-embedded-subscribe.handlers.types.js";
import { createClaudeSdkMcpToolServer } from "./mcp-tool-server.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type AnyAgentToolLike = {
  name: string;
  description?: string;
  parameters: ReturnType<typeof Type.Object>;
  ownerOnly?: boolean;
  execute: Mock;
};

function makeTool(overrides?: Partial<AnyAgentToolLike>): AnyAgentToolLike {
  return {
    name: "read_file",
    description: "Read a file from the filesystem",
    parameters: Type.Object({ path: Type.String() }),
    execute: vi.fn().mockResolvedValue("file contents"),
    ...overrides,
  };
}

function makePendingToolUseIdConsumer(
  initialByTool: Record<string, string[]> = {},
): () => { id: string; name: string; input: unknown } | undefined {
  const pendingQueue: Array<{ id: string; name: string; input: unknown }> = [];
  for (const [toolName, ids] of Object.entries(initialByTool)) {
    for (const id of ids) {
      pendingQueue.push({ id, name: toolName, input: {} });
    }
  }
  let generatedCount = 0;
  return () => {
    if (pendingQueue.length > 0) {
      return pendingQueue.shift();
    }
    generatedCount += 1;
    return { id: `call_auto_${generatedCount}`, name: "read_file", input: {} };
  };
}

function makeToolServer(tools: AnyAgentToolLike[]): {
  capturedEvents: EmbeddedPiSubscribeEvent[];
  emitEvent: (evt: EmbeddedPiSubscribeEvent) => void;
  getAbortSignal: () => AbortSignal | undefined;
} {
  const events: EmbeddedPiSubscribeEvent[] = [];
  const emitEvent = (evt: EmbeddedPiSubscribeEvent) => events.push(evt);
  const getAbortSignal = () => undefined;

  createClaudeSdkMcpToolServer({
    tools: tools as never[],
    emitEvent,
    getAbortSignal,
    consumePendingToolUse: makePendingToolUseIdConsumer(),
  });

  return { capturedEvents: events, emitEvent, getAbortSignal };
}

/**
 * Gets the registered tool handler for a given tool name from the captured server.
 */
function getToolHandler(
  name: string,
): (args: Record<string, unknown>, extra?: unknown) => Promise<unknown> {
  if (!capturedServer) {
    throw new Error("No MCP server was created");
  }
  const def = capturedServer.tools.find((t) => t.name === name);
  if (!def) {
    throw new Error(`Tool "${name}" not found`);
  }
  return def.handler;
}

// ---------------------------------------------------------------------------
// Section 2.1: MCP Tool Server Registration
// ---------------------------------------------------------------------------

describe("mcp-tool-server — tool registration", () => {
  beforeEach(() => {
    capturedServer = null;
    vi.clearAllMocks();
  });

  it("registers all provided tools with correct names", () => {
    const tools = [
      makeTool({ name: "read_file" }),
      makeTool({ name: "write_file" }),
      makeTool({ name: "bash" }),
    ];
    makeToolServer(tools);

    expect(capturedServer?.tools).toHaveLength(3);
    const names = capturedServer?.tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("bash");
  });

  it("preserves tool descriptions in MCP definitions", () => {
    const tools = [makeTool({ name: "read_file", description: "Read a file from the filesystem" })];
    makeToolServer(tools);

    const def = capturedServer?.tools.find((t) => t.name === "read_file");
    expect(def?.description).toBe("Read a file from the filesystem");
  });

  it("registers tools with TypeBox schemas without throwing", () => {
    const tools = [
      makeTool({
        name: "search",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          maxResults: Type.Optional(Type.Number()),
        }),
      }),
    ];
    // Should not throw during registration
    expect(() => makeToolServer(tools)).not.toThrow();
  });

  it("creates MCP server with correct name and version", () => {
    makeToolServer([makeTool()]);
    expect(capturedServer?.name).toBe("openclaw-tools");
    expect(capturedServer?.version).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// Section 2.2: Tool Lifecycle Events
// ---------------------------------------------------------------------------

describe("mcp-tool-server — tool lifecycle events", () => {
  beforeEach(() => {
    capturedServer = null;
    vi.clearAllMocks();
  });

  it("emits tool_execution_start before calling .execute()", async () => {
    let startEmittedBeforeExecute = false;
    let executeCallCount = 0;

    const tool = makeTool({
      name: "read_file",
      execute: vi.fn(async () => {
        executeCallCount++;
        return "result";
      }),
    });

    const events: EmbeddedPiSubscribeEvent[] = [];
    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => {
        events.push(evt);
        // Check if start is emitted before execute was called
        const startEvt = evt as { type: string };
        if (startEvt.type === "tool_execution_start" && executeCallCount === 0) {
          startEmittedBeforeExecute = true;
        }
      },
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    expect(startEmittedBeforeExecute).toBe(true);
    expect(
      events.find((e) => (e as { type: string }).type === "tool_execution_start"),
    ).toBeDefined();
  });

  it("tool_execution_start has correct fields", async () => {
    const tool = makeTool({ name: "read_file" });
    const events: EmbeddedPiSubscribeEvent[] = [];

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    const startEvt = events.find(
      (e) => (e as { type: string }).type === "tool_execution_start",
    ) as Record<string, unknown>;
    expect(startEvt).toBeDefined();
    expect(startEvt.toolName).toBe("read_file");
    expect(typeof startEvt.toolCallId).toBe("string");
    expect(startEvt.args).toEqual({ path: "/foo.ts" });
  });

  it("uses pending assistant tool_use id from SDK messages", async () => {
    const tool = makeTool({ name: "read_file" });
    const events: EmbeddedPiSubscribeEvent[] = [];

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer({
        read_file: ["call_from_assistant"],
      }),
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    expect(tool.execute).toHaveBeenCalledWith(
      "call_from_assistant",
      { path: "/foo.ts" },
      undefined,
      expect.any(Function),
    );
    const startEvt = events.find(
      (e) => (e as { type: string }).type === "tool_execution_start",
    ) as Record<string, unknown>;
    expect(startEvt.toolCallId).toBe("call_from_assistant");
  });

  it("returns structured MCP error when no SDK tool_use id is available", async () => {
    const tool = makeTool({ name: "read_file" });
    const events: EmbeddedPiSubscribeEvent[] = [];
    const appendRuntimeMessage = vi.fn();
    const appendMessage = vi.fn();

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => undefined,
      consumePendingToolUse: () => undefined,
      appendRuntimeMessage,
      sessionManager: { appendMessage },
    });

    const handler = getToolHandler("read_file");
    const result = (await handler({ path: "/foo.ts" }, {})) as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.type).toBe("text");
    expect(result.content?.[0]?.text).toContain('"code":"missing_tool_use_id"');
    const eventTypes = events.map((evt) => (evt as { type: string }).type);
    expect(eventTypes).toContain("tool_execution_start");
    expect(eventTypes).toContain("tool_execution_end");
    expect(appendRuntimeMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledTimes(1);
  });

  it("emits tool_execution_end with output on success", async () => {
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockResolvedValue("file contents here"),
    });
    const events: EmbeddedPiSubscribeEvent[] = [];

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    const mcpResult = await handler({ path: "/foo.ts" }, {});

    const endEvt = events.find(
      (e) => (e as { type: string }).type === "tool_execution_end",
    ) as Record<string, unknown>;
    expect(endEvt).toBeDefined();
    expect(typeof endEvt.toolCallId).toBe("string");
    expect(endEvt.result).toBe("file contents here");
    expect(endEvt.isError).toBe(false);

    // MCP result should be text content
    const result = mcpResult as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe("file contents here");
    expect(result.isError).toBeFalsy();
  });

  it("formats object results as JSON text blocks", async () => {
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockResolvedValue({ ok: true, count: 2 }),
    });
    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    const mcpResult = (await handler({ path: "/foo.ts" }, {})) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(mcpResult.content).toEqual([{ type: "text", text: '{"ok":true,"count":2}' }]);
  });

  it("formats array results as JSON text blocks", async () => {
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockResolvedValue(["a", "b", 3]),
    });
    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    const mcpResult = (await handler({ path: "/foo.ts" }, {})) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(mcpResult.content).toEqual([{ type: "text", text: '["a","b",3]' }]);
  });

  it("formats undefined tool results as a string text block", async () => {
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockResolvedValue(undefined),
    });
    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    const mcpResult = (await handler({ path: "/foo.ts" }, {})) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    expect(mcpResult.isError).toBeFalsy();
    expect(mcpResult.content).toEqual([{ type: "text", text: "undefined" }]);
  });

  it("keeps ownerOnly tools registered and executable when provided to the MCP server", async () => {
    const tool = makeTool({
      name: "secure_tool",
      ownerOnly: true,
      execute: vi.fn().mockResolvedValue("secure result"),
    });
    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer({ secure_tool: ["call_owner_only"] }),
    });

    const handler = getToolHandler("secure_tool");
    const result = (await handler({ action: "run" }, {})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toBe("secure result");
    expect(tool.execute).toHaveBeenCalledWith(
      "call_owner_only",
      { action: "run" },
      undefined,
      expect.any(Function),
    );
  });

  it("emits tool_execution_end with error on failure and MCP isError: true", async () => {
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockRejectedValue(new Error("Permission denied")),
    });
    const events: EmbeddedPiSubscribeEvent[] = [];

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    const mcpResult = await handler({ path: "/foo.ts" }, {});

    const endEvt = events.find(
      (e) => (e as { type: string }).type === "tool_execution_end",
    ) as Record<string, unknown>;
    expect(endEvt).toBeDefined();
    expect(endEvt.isError).toBe(true);
    expect(typeof endEvt.result).toBe("string");
    expect(String(endEvt.result)).toContain("Permission denied");

    const result = mcpResult as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Permission denied");
  });

  it("emits tool_execution_update on progress", async () => {
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn(
        async (_id: string, _args: unknown, _signal: unknown, onUpdate: (u: unknown) => void) => {
          onUpdate({ message: "Reading..." });
          onUpdate({ message: "Done reading" });
          return "result";
        },
      ),
    });
    const events: EmbeddedPiSubscribeEvent[] = [];

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    const updates = events.filter((e) => (e as { type: string }).type === "tool_execution_update");
    expect(updates.length).toBe(2);
  });

  it("keeps event type as tool_execution_update even if onUpdate payload includes a type field", async () => {
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn(
        async (_id: string, _args: unknown, _signal: unknown, onUpdate: (u: unknown) => void) => {
          onUpdate({ type: "progress", message: "Reading..." });
          return "result";
        },
      ),
    });
    const events: EmbeddedPiSubscribeEvent[] = [];

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    const updateEvt = events.find(
      (e) => (e as { type?: string }).type === "tool_execution_update",
    ) as Record<string, unknown> | undefined;
    expect(updateEvt).toBeDefined();
    expect(updateEvt?.type).toBe("tool_execution_update");
  });

  it("tool lifecycle follows start → update* → end ordering", async () => {
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn(
        async (_id: string, _args: unknown, _signal: unknown, onUpdate: (u: unknown) => void) => {
          onUpdate({ step: 1 });
          return "done";
        },
      ),
    });
    const events: EmbeddedPiSubscribeEvent[] = [];

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    const types = events.map((e) => (e as { type: string }).type);
    const startIdx = types.indexOf("tool_execution_start");
    const updateIdx = types.indexOf("tool_execution_update");
    const endIdx = types.indexOf("tool_execution_end");

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    if (updateIdx >= 0) {
      expect(updateIdx).toBeGreaterThan(startIdx);
      expect(updateIdx).toBeLessThan(endIdx);
    }
  });

  it("concurrent tool calls maintain per-tool start→end ordering", async () => {
    const toolA = makeTool({ name: "tool_a", execute: vi.fn().mockResolvedValue("result-a") });
    const toolB = makeTool({ name: "tool_b", execute: vi.fn().mockResolvedValue("result-b") });
    const events: EmbeddedPiSubscribeEvent[] = [];

    createClaudeSdkMcpToolServer({
      tools: [toolA, toolB] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handlerA = getToolHandler("tool_a");
    const handlerB = getToolHandler("tool_b");

    // Run both concurrently
    await Promise.all([handlerA({ x: 1 }, {}), handlerB({ x: 2 }, {})]);

    // For each toolCallId, start must come before end
    const toolCallIds = new Set(
      events
        .filter((e) =>
          ["tool_execution_start", "tool_execution_end"].includes((e as { type: string }).type),
        )
        .map((e) => (e as { toolCallId?: string }).toolCallId),
    );

    // Must have 2 distinct toolCallIds
    expect(toolCallIds.size).toBe(2);

    for (const toolCallId of toolCallIds) {
      const forTool = events.filter(
        (e) => (e as { toolCallId?: string }).toolCallId === toolCallId,
      );
      const types = forTool.map((e) => (e as { type: string }).type);
      const startIdx = types.indexOf("tool_execution_start");
      const endIdx = types.indexOf("tool_execution_end");
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
    }
  });

  it("uses provided abort signal in .execute() call", async () => {
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const tool = makeTool({
      name: "read_file",
      execute: vi.fn(async (_id: string, _args: unknown, signal: AbortSignal | undefined) => {
        receivedSignal = signal;
        return "done";
      }),
    });
    const events: EmbeddedPiSubscribeEvent[] = [];

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: (evt) => events.push(evt),
      getAbortSignal: () => abortController.signal,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    expect(receivedSignal).toBe(abortController.signal);
  });
});

// ---------------------------------------------------------------------------
// Section: Tool Result Persistence via sessionManager
// ---------------------------------------------------------------------------

describe("mcp-tool-server — toolResult persistence", () => {
  beforeEach(() => {
    capturedServer = null;
    vi.clearAllMocks();
  });

  it("calls sessionManager.appendMessage with correct toolResult on success", async () => {
    const appendMessage = vi.fn().mockReturnValue("msg-id");
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockResolvedValue("file contents here"),
    });

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
      sessionManager: { appendMessage },
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    expect(appendMessage).toHaveBeenCalledTimes(1);
    const msg = appendMessage.mock.calls[0][0];
    expect(msg.role).toBe("toolResult");
    expect(msg.toolName).toBe("read_file");
    expect(typeof msg.toolCallId).toBe("string");
    expect(msg.isError).toBe(false);
    expect(msg.content).toEqual([{ type: "text", text: "file contents here" }]);
    expect(typeof msg.timestamp).toBe("number");
  });

  it("summarizes image tool results in transcript persistence without embedding payload bytes", async () => {
    const appendMessage = vi.fn().mockReturnValue("msg-id");
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockResolvedValue({
        content: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAE=", mediaType: "image/png" }],
      }),
    });

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
      sessionManager: { appendMessage },
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    const msg = appendMessage.mock.calls[0][0];
    expect(msg.role).toBe("toolResult");
    expect(msg.content[0].type).toBe("text");
    expect(msg.content[0].text).toContain("[tool_image_ref");
    expect(msg.content[0].text).not.toContain("iVBORw0KGgoAAAANSUhEUgAAAAE=");
  });

  it("appends toolResult to runtime history callback on success", async () => {
    const appendRuntimeMessage = vi.fn();
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockResolvedValue("file contents here"),
    });

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
      appendRuntimeMessage,
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    expect(appendRuntimeMessage).toHaveBeenCalledTimes(1);
    const runtimeMsg = appendRuntimeMessage.mock.calls[0][0];
    expect(runtimeMsg.role).toBe("toolResult");
    expect(runtimeMsg.toolName).toBe("read_file");
    expect(runtimeMsg.isError).toBe(false);
  });

  it("calls sessionManager.appendMessage with isError true on failure", async () => {
    const appendMessage = vi.fn().mockReturnValue("msg-id");
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockRejectedValue(new Error("Permission denied")),
    });

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
      sessionManager: { appendMessage },
    });

    const handler = getToolHandler("read_file");
    await handler({ path: "/foo.ts" }, {});

    expect(appendMessage).toHaveBeenCalledTimes(1);
    const msg = appendMessage.mock.calls[0][0];
    expect(msg.role).toBe("toolResult");
    expect(msg.toolName).toBe("read_file");
    expect(msg.isError).toBe(true);
    expect(msg.content).toEqual([{ type: "text", text: "Permission denied" }]);
  });

  it("does not throw when sessionManager is undefined", async () => {
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockResolvedValue("ok"),
    });

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
      // No sessionManager
    });

    const handler = getToolHandler("read_file");
    // Should not throw
    await expect(handler({ path: "/foo.ts" }, {})).resolves.toBeDefined();
  });

  it("does not throw when sessionManager.appendMessage throws", async () => {
    const appendMessage = vi.fn().mockImplementation(() => {
      throw new Error("DB write failed");
    });
    const tool = makeTool({
      name: "read_file",
      execute: vi.fn().mockResolvedValue("ok"),
    });

    createClaudeSdkMcpToolServer({
      tools: [tool] as never[],
      emitEvent: () => {},
      getAbortSignal: () => undefined,
      consumePendingToolUse: makePendingToolUseIdConsumer(),
      sessionManager: { appendMessage },
    });

    const handler = getToolHandler("read_file");
    // Should not throw even though appendMessage throws
    const result = await handler({ path: "/foo.ts" }, {});
    expect(result).toBeDefined();
  });
});
