import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_TOOL_NAME_CONFLICT_PREFIX,
  createClientToolNameConflictError,
  findClientToolNameConflicts,
  isClientToolNameConflictError,
  toClientToolDefinitions,
  toToolDefinitions,
} from "./agent-tool-definition-adapter.js";
import type { ClientToolDefinition } from "./embedded-agent-runner/run/params.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

async function executeThrowingTool(name: string, callId: string) {
  const tool = {
    name,
    label: name === "bash" ? "Bash" : "Boom",
    description: "throws",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("nope");
    },
  } satisfies AgentTool;

  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

async function executeTool(tool: AgentTool, callId: string) {
  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

describe("agent tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const result = await executeThrowingTool("boom", "call1");

    const details = result.details as
      | { status?: string; tool?: string; error?: string }
      | undefined;
    expect(details?.status).toBe("error");
    expect(details?.tool).toBe("boom");
    expect(details?.error).toBe("nope");
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const result = await executeThrowingTool("bash", "call2");

    const details = result.details as
      | { status?: string; tool?: string; error?: string }
      | undefined;
    expect(details?.status).toBe("error");
    expect(details?.tool).toBe("exec");
    expect(details?.error).toBe("nope");
  });

  it("coerces details-only tool results to include content", async () => {
    const tool = {
      name: "memory_query",
      label: "Memory Query",
      description: "returns details only",
      parameters: Type.Object({}),
      execute: (async () => ({
        details: {
          hits: [{ id: "a1", score: 0.9 }],
        },
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call3");
    expect(result.details).toEqual({
      hits: [{ id: "a1", score: 0.9 }],
    });
    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text?: string }).text).toContain('"hits"');
  });

  it("coerces non-standard object results to include content", async () => {
    const tool = {
      name: "memory_query_raw",
      label: "Memory Query Raw",
      description: "returns plain object",
      parameters: Type.Object({}),
      execute: (async () => ({
        count: 2,
        ids: ["m1", "m2"],
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call4");
    expect(result.details).toEqual({
      count: 2,
      ids: ["m1", "m2"],
    });
    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text?: string }).text).toContain('"count"');
  });

  it("records normalized adapter tool outcomes for terminal fallback", async () => {
    const onToolOutcome = vi.fn();
    const tool = {
      name: "memory_query",
      label: "Memory Query",
      description: "queries memory",
      parameters: Type.Object({ query: Type.String() }),
      terminalResultFallback: { mode: "safe_text", prefix: "Memory:" },
      execute: async () => ({
        content: [{ type: "text" as const, text: "found composer 2.5" }],
        terminalSummary: {
          privacy: "public" as const,
          text: "memory returned one hit",
          maxChars: 80,
        },
        details: { count: 1 },
      }),
    } satisfies AgentTool;

    const [def] = toToolDefinitions([tool], {
      sessionId: "adapter-terminal-fallback-success",
      runId: "run-adapter-terminal-fallback-success",
      onToolOutcome,
    });
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-adapter-success",
      { query: "composer 2.5" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "memory_query",
        resultText: "found composer 2.5",
        terminalSummary: {
          privacy: "public",
          text: "memory returned one hit",
          maxChars: 80,
        },
        terminalResultFallback: { mode: "safe_text", prefix: "Memory:" },
      }),
    );
  });

  it("bounds retained terminal fallback result text", async () => {
    const onToolOutcome = vi.fn();
    const output = "x".repeat(70_000);
    const tool = {
      name: "large_status",
      label: "Large Status",
      description: "returns a large status",
      parameters: Type.Object({}),
      terminalResultFallback: { mode: "safe_text" },
      execute: async () => ({
        content: [{ type: "text" as const, text: output }],
        details: { ok: true },
      }),
    } satisfies AgentTool;

    const [def] = toToolDefinitions([tool], {
      sessionId: "adapter-terminal-fallback-large-result",
      runId: "run-adapter-terminal-fallback-large-result",
      onToolOutcome,
    });
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute("call-adapter-large-result", {}, undefined, undefined, extensionContext);

    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "large_status",
        resultText: "x".repeat(64_000),
        terminalResultFallback: { mode: "safe_text" },
      }),
    );
  });

  it("does not retain raw result text without a declared terminal fallback", async () => {
    const onToolOutcome = vi.fn();
    const tool = {
      name: "private_status",
      label: "Private Status",
      description: "returns private status",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "private customer payload" }],
        details: { ok: true },
      }),
    } satisfies AgentTool;

    const [def] = toToolDefinitions([tool], {
      sessionId: "adapter-no-terminal-fallback-result",
      runId: "run-adapter-no-terminal-fallback-result",
      onToolOutcome,
    });
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute("call-adapter-private-result", {}, undefined, undefined, extensionContext);

    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.not.objectContaining({
        resultText: expect.anything(),
      }),
    );
  });

  it("records message tool text aliases for terminal fallback delivery evidence", async () => {
    const onToolOutcome = vi.fn();
    const tool = {
      name: "message",
      label: "Message",
      description: "sends a message",
      parameters: Type.Object({
        action: Type.String(),
        to: Type.String(),
        text: Type.String(),
      }),
      execute: async () => ({
        content: [{ type: "text" as const, text: "sent" }],
        details: { deliveryStatus: "sent", messageId: "msg-1" },
      }),
    } satisfies AgentTool;

    const [def] = toToolDefinitions([tool], {
      sessionId: "adapter-message-text-alias-terminal-fallback",
      runId: "run-adapter-message-text-alias-terminal-fallback",
      onToolOutcome,
    });
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-adapter-message-text-alias",
      { action: "send", to: "discord:channel-1", text: "alias text" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "message",
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["alias text"],
      }),
    );
  });

  it("records plugin message content receipts as delivery evidence", async () => {
    const onToolOutcome = vi.fn();
    const tool = {
      name: "message",
      label: "Message",
      description: "sends a plugin message",
      parameters: Type.Object({
        action: Type.String(),
        to: Type.String(),
        text: Type.String(),
      }),
      execute: async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              channel: "mattermost",
              messageId: "message-1",
            }),
          },
        ],
        details: {},
      }),
    } satisfies AgentTool;

    const [def] = toToolDefinitions([tool], {
      sessionId: "adapter-message-content-receipt",
      runId: "run-adapter-message-content-receipt",
      onToolOutcome,
    });
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-adapter-message-content-receipt",
      { action: "send", to: "mattermost:channel-1", text: "plugin text" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "message",
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["plugin text"],
      }),
    );
  });

  it("records message tool media and rich targets for terminal fallback delivery evidence", async () => {
    const onToolOutcome = vi.fn();
    const tool = {
      name: "message",
      label: "Message",
      description: "sends a rich message",
      parameters: Type.Object({
        action: Type.String(),
        to: Type.String(),
        mediaUrl: Type.String(),
        presentation: Type.Any(),
      }),
      execute: async () => ({
        content: [{ type: "text" as const, text: "sent media" }],
        details: { deliveryStatus: "sent", messageId: "msg-media-1" },
      }),
    } satisfies AgentTool;

    const [def] = toToolDefinitions([tool], {
      sessionId: "adapter-message-media-terminal-fallback",
      runId: "run-adapter-message-media-terminal-fallback",
      onToolOutcome,
    });
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-adapter-message-media",
      {
        action: "sendAttachment",
        to: "discord:channel-1",
        mediaUrl: "file:///tmp/render.png",
        presentation: { title: "Preview" },
      },
      undefined,
      undefined,
      extensionContext,
    );

    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "message",
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
        messagingToolSentTargets: [
          expect.objectContaining({
            tool: "message",
            provider: "message",
            to: "discord:channel-1",
            mediaUrl: "file:///tmp/render.png",
            mediaUrls: ["file:///tmp/render.png"],
            presentation: expect.objectContaining({ title: "Preview" }),
          }),
        ],
      }),
    );
  });

  it("does not retain adapter error text without a terminal fallback", async () => {
    const onToolOutcome = vi.fn();
    const tool = {
      name: "status_check",
      label: "Status Check",
      description: "checks status",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("service unavailable");
      },
    } satisfies AgentTool;

    const [def] = toToolDefinitions([tool], {
      sessionId: "adapter-terminal-fallback-error",
      runId: "run-adapter-terminal-fallback-error",
      onToolOutcome,
    });
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute("call-adapter-error", {}, undefined, undefined, extensionContext);

    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "status_check",
        failed: true,
      }),
    );
    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.not.objectContaining({
        resultText: expect.anything(),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// toClientToolDefinitions – streaming tool-call argument coercion (#57009)
// ---------------------------------------------------------------------------

function makeClientTool(name: string): ClientToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  };
}

async function executeClientTool(params: unknown): Promise<{
  calledWith: Record<string, unknown> | undefined;
  result: Awaited<ReturnType<ToolExecute>>;
}> {
  let captured: Record<string, unknown> | undefined;
  const [def] = toClientToolDefinitions([makeClientTool("search")], (_name, p) => {
    captured = p;
  });
  if (!def) {
    throw new Error("missing client tool definition");
  }
  const result = await def.execute("call-c1", params, undefined, undefined, extensionContext);
  return { calledWith: captured, result };
}

describe("toClientToolDefinitions – param coercion", () => {
  it("returns terminal pending results for each client tool in a batch", async () => {
    const completed: Array<{ id: string; name: string; params: Record<string, unknown> }> = [];
    const defs = toClientToolDefinitions([makeClientTool("search"), makeClientTool("lookup")], {
      complete: (id, name, params) => {
        completed.push({ id, name, params });
      },
    });
    const [search, lookup] = defs;
    if (!search || !lookup) {
      throw new Error("missing client tool definition");
    }

    const [searchResult, lookupResult] = await Promise.all([
      search.execute("call-search", { query: "first" }, undefined, undefined, extensionContext),
      lookup.execute("call-lookup", { query: "second" }, undefined, undefined, extensionContext),
    ]);

    expect(searchResult.terminate).toBe(true);
    expect(lookupResult.terminate).toBe(true);
    expect(completed).toEqual([
      { id: "call-search", name: "search", params: { query: "first" } },
      { id: "call-lookup", name: "lookup", params: { query: "second" } },
    ]);
  });

  it("passes plain object params through unchanged", async () => {
    const { calledWith, result } = await executeClientTool({ query: "hello" });
    expect(calledWith).toEqual({ query: "hello" });
    expect(result.terminate).toBe(true);
  });

  it("parses a JSON string into an object (streaming delta accumulation)", async () => {
    const { calledWith } = await executeClientTool('{"query":"hello","limit":10}');
    expect(calledWith).toEqual({ query: "hello", limit: 10 });
  });

  it("parses a JSON string with surrounding whitespace", async () => {
    const { calledWith } = await executeClientTool('  {"query":"hello"}  ');
    expect(calledWith).toEqual({ query: "hello" });
  });

  it("falls back to empty object for invalid JSON string", async () => {
    const { calledWith } = await executeClientTool("not-json");
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for empty string", async () => {
    const { calledWith } = await executeClientTool("");
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for null", async () => {
    const { calledWith } = await executeClientTool(null);
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for undefined", async () => {
    const { calledWith } = await executeClientTool(undefined);
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for a JSON array string", async () => {
    const { calledWith } = await executeClientTool("[1,2,3]");
    expect(calledWith).toStrictEqual({});
  });

  it("handles nested JSON string correctly", async () => {
    const { calledWith } = await executeClientTool(
      '{"action":"search","params":{"q":"test","page":1}}',
    );
    expect(calledWith).toEqual({ action: "search", params: { q: "test", page: 1 } });
  });
});

describe("client tool name conflict checks", () => {
  it("detects collisions with existing built-in names after normalization", () => {
    expect(
      findClientToolNameConflicts({
        tools: [makeClientTool("Web_Search"), makeClientTool("exec")],
        existingToolNames: ["web_search", "read"],
      }),
    ).toEqual(["Web_Search"]);
  });

  it("detects duplicate client tool names after normalization", () => {
    expect(
      findClientToolNameConflicts({
        tools: [makeClientTool("Weather"), makeClientTool("weather")],
      }),
    ).toEqual(["Weather", "weather"]);
  });

  it("detects collisions with reserved OpenClaw built-in tool names", () => {
    expect(
      findClientToolNameConflicts({
        tools: [makeClientTool("Bash"), makeClientTool("grep")],
        existingToolNames: ["bash", "edit", "find", "grep", "ls", "read", "write"],
      }),
    ).toEqual(["Bash", "grep"]);
  });

  it("wraps conflict errors with a stable prefix", () => {
    const err = createClientToolNameConflictError(["exec", "Web_Search"]);
    expect(err.message).toBe(`${CLIENT_TOOL_NAME_CONFLICT_PREFIX} exec, Web_Search`);
    expect(isClientToolNameConflictError(err)).toBe(true);
    expect(isClientToolNameConflictError(new Error("other failure"))).toBe(false);
  });
});
