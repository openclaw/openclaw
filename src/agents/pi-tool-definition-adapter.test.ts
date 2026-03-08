import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as sessionSanitizationService from "../memory/session-sanitization/service.js";
import { schemaValidation } from "../memory/session-sanitization/validation.js";
import { toToolDefinitions, wrapMcpToolDefinitions } from "./pi-tool-definition-adapter.js";

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

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const result = await executeThrowingTool("boom", "call1");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const result = await executeThrowingTool("bash", "call2");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
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
    expect(result.content[0]).toMatchObject({ type: "text" });
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
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toContain('"count"');
  });

  it("marks non-required JSON schema fields as optional when converting MCP output schema", async () => {
    const processSpy = vi
      .spyOn(sessionSanitizationService, "processMcpToolResult")
      .mockResolvedValue({
        trusted: false,
        safe: true,
        structuredResult: { ok: true },
        flags: [],
        contextNote: "ok",
      });

    const cfg = {
      mcpServers: {
        "community-search": {
          tools: ["web_search"],
        },
      },
    } as OpenClawConfig;

    const toolDef = {
      name: "web_search",
      label: "Web Search",
      description: "MCP search tool",
      parameters: Type.Object({}),
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          optionalTitle: { type: "string" },
        },
        required: ["id"],
      },
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: { id: "1" },
      }),
    } as unknown as ReturnType<typeof toToolDefinitions>[number];

    const wrapped = wrapMcpToolDefinitions([toolDef], {
      cfg,
      agentId: "main",
      sessionId: "sess-1",
    });
    const wrappedDef = wrapped[0];
    if (!wrappedDef) {
      throw new Error("missing wrapped definition");
    }

    await wrappedDef.execute("call-1", {}, undefined, undefined, extensionContext);

    expect(processSpy).toHaveBeenCalledOnce();
    const mcpParams = processSpy.mock.calls[0]?.[0];
    expect(mcpParams?.toolSchema).toEqual({
      fields: {
        id: "string",
        optionalTitle: "string | undefined",
      },
    });
    processSpy.mockRestore();
  });

  it("passes MCP payload (details) to sanitization instead of the AgentToolResult envelope", async () => {
    const processSpy = vi
      .spyOn(sessionSanitizationService, "processMcpToolResult")
      .mockResolvedValue({
        trusted: false,
        safe: true,
        structuredResult: { ok: true },
        flags: [],
        contextNote: "ok",
      });

    const cfg = {
      mcpServers: {
        "community-search": {
          tools: ["web_search"],
        },
      },
    } as OpenClawConfig;

    const payload = { id: 1, name: "test" };
    const toolDef = {
      name: "web_search",
      label: "Web Search",
      description: "MCP search tool",
      parameters: Type.Object({}),
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      }),
    } as unknown as ReturnType<typeof toToolDefinitions>[number];

    const wrapped = wrapMcpToolDefinitions([toolDef], {
      cfg,
      agentId: "main",
      sessionId: "sess-1",
    });
    const wrappedDef = wrapped[0];
    if (!wrappedDef) {
      throw new Error("missing wrapped definition");
    }

    await wrappedDef.execute("call-1", {}, undefined, undefined, extensionContext);

    expect(processSpy).toHaveBeenCalledOnce();
    const mcpParams = processSpy.mock.calls[0]?.[0];
    expect(mcpParams?.rawResult).toEqual(payload);
    const schema = schemaValidation(mcpParams?.rawResult, "mcp", mcpParams?.toolSchema);
    expect(schema.pass).toBe(true);
    expect(schema.ruleIds).not.toContain("schema.extra-field");
    expect(schema.ruleIds).not.toContain("schema.missing-field");
    processSpy.mockRestore();
  });

  it("preserves fail-open passthrough while surfacing sandbox-skip context note", async () => {
    const processSpy = vi
      .spyOn(sessionSanitizationService, "processMcpToolResult")
      .mockResolvedValue({
        trusted: false,
        safe: true,
        sandboxSkip: true,
        structuredResult: { raw: "unchanged" },
        flags: ["sandbox unavailable — sanitization skipped per config"],
        contextNote: "sandbox unavailable, sanitization skipped",
      });

    const cfg = {
      mcpServers: {
        "community-search": {
          tools: ["web_search"],
        },
      },
    } as OpenClawConfig;

    const original = {
      content: [{ type: "text", text: '{"ok":true}' }],
      details: { ok: true, via: "raw-result" },
    };
    const toolDef = {
      name: "web_search",
      label: "Web Search",
      description: "MCP search tool",
      parameters: Type.Object({}),
      execute: async () => original,
    } as unknown as ReturnType<typeof toToolDefinitions>[number];

    const wrapped = wrapMcpToolDefinitions([toolDef], {
      cfg,
      agentId: "main",
      sessionId: "sess-1",
    });
    const wrappedDef = wrapped[0];
    if (!wrappedDef) {
      throw new Error("missing wrapped definition");
    }

    const result = await wrappedDef.execute("call-1", {}, undefined, undefined, extensionContext);
    expect(processSpy).toHaveBeenCalledOnce();
    expect(result.details).toEqual(original.details);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "sandbox unavailable, sanitization skipped",
    });
    expect(result.content[1]).toEqual(original.content[0]);
    processSpy.mockRestore();
  });
});
