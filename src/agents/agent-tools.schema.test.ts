import { normalizeToolParameterSchema } from "@openclaw/ai/internal/tool-schema";
import { runAgentLoop, type AgentEvent, type StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, validateToolArguments } from "openclaw/plugin-sdk/llm";
import { Type, type TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import {
  assertRequiredParams,
  REQUIRED_PARAM_GROUPS,
  normalizeFileToolPathParam,
  wrapToolParamValidation,
} from "./agent-tools.params.js";
import { normalizeToolParameters } from "./agent-tools.schema.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createProcessTool } from "./bash-tools.process.js";
import {
  getBeforeToolCallHookContext,
  getBeforeToolCallSourceTool,
} from "./before-tool-call-metadata.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

async function runToolCall(
  tool: AnyAgentTool,
  toolCall: Parameters<typeof validateToolArguments>[1],
  prompt: string,
) {
  const events: AgentEvent[] = [];
  let streamCalls = 0;
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      streamCalls += 1;
      const message = {
        role: "assistant" as const,
        content: streamCalls === 1 ? [toolCall] : [{ type: "text" as const, text: "done" }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: createZeroUsageFixture(),
        stopReason: streamCalls === 1 ? ("toolUse" as const) : ("stop" as const),
        timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };

  const messages = await runAgentLoop(
    [{ role: "user", content: prompt, timestamp: Date.now() }],
    { systemPrompt: "test", messages: [], tools: [tool] },
    {
      model: {
        id: "faux-1",
        name: "Faux",
        provider: "faux",
        api: "faux",
        baseUrl: "http://localhost:0",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
      convertToLlm: (agentMessages) => agentMessages as never,
    },
    (event) => {
      events.push(event);
    },
    undefined,
    streamFn,
  );
  return { messages, events, streamCalls };
}

describe("direct process tool schema", () => {
  it("rejects unknown process actions without starting execution", async () => {
    const processTool = createProcessTool();
    const execute = vi.spyOn(processTool, "execute");
    const { messages, events } = await runToolCall(
      processTool,
      {
        type: "toolCall",
        id: "call-unknown-process-action",
        name: "process",
        arguments: { action: "delete" },
      },
      "inspect processes",
    );

    expect(execute).not.toHaveBeenCalled();
    const toolResult = messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(toolResult)).toContain('Validation failed for tool \\"process\\"');
    expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
      executionStarted: false,
      errorKind: "argument-validation",
    });
  });
});

describe("normalizeToolParameterSchema", () => {
  it("keeps normalized tool-schema profile behavior aligned with the cache key", () => {
    const schema = {
      type: "object",
      properties: {
        sessionKey: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
    };

    const defaultSchema = normalizeToolParameterSchema(schema, {
      modelProvider: "openai-compatible",
      modelId: "custom-model",
    });
    const mixedCaseGeminiProfileSchema = normalizeToolParameterSchema(schema, {
      modelProvider: "openai-compatible",
      modelId: "custom-model",
      modelCompat: { toolSchemaProfile: "Gemini" },
    });

    expect(defaultSchema).toEqual(schema);
    expect(mixedCaseGeminiProfileSchema).toEqual({
      type: "object",
      properties: {
        sessionKey: { type: "string" },
      },
    });
  });

  it("applies llama.cpp cleaning only for the explicit tool-schema profile", () => {
    const schema = {
      type: "object",
      properties: {
        declarationKey: { type: "string", pattern: "^\\S+$", maxLength: 200 },
        safe: { type: "string", maxLength: 1999 },
        boundary: { type: "string", maxLength: 2000 },
        script: { type: "string", minLength: 1, maxLength: 65_536 },
      },
    };

    expect(normalizeToolParameterSchema(schema, { modelProvider: "openai" })).toEqual(schema);
    expect(
      normalizeToolParameterSchema(schema, {
        modelProvider: "openai-compatible",
        modelCompat: { toolSchemaProfile: "llamacpp" },
      }),
    ).toEqual({
      type: "object",
      properties: {
        declarationKey: { type: "string", maxLength: 200 },
        safe: { type: "string", maxLength: 1999 },
        boundary: { type: "string" },
        script: { type: "string", minLength: 1 },
      },
    });
  });

  it("applies explicit unsupported keyword stripping after Gemini cleanup", () => {
    expect(
      normalizeToolParameterSchema(
        {
          type: "object",
          properties: {
            count: {
              anyOf: [{ type: "integer", vendorOnly: true }, { type: "null" }],
            },
          },
        },
        {
          modelProvider: "jjcc",
          modelId: "gemini-3.1-pro-preview",
          modelCompat: { unsupportedToolSchemaKeywords: ["vendorOnly"] },
        },
      ),
    ).toEqual({
      type: "object",
      properties: {
        count: { type: "integer" },
      },
    });
  });

  it("rejects noncanonical array indices in local $ref paths", () => {
    const indices = ["0", "1", "0x1", "1e0", "01", "+0", "-0", "", " "];
    const properties = Object.fromEntries(
      indices.map((index) => [index, { $ref: `#/$defs/Choice/anyOf/${index}` }]),
    );
    const unresolved = structuredClone(properties);
    const normalized = normalizeToolParameterSchema({
      type: "object",
      properties,
      $defs: { Choice: { anyOf: [{ type: "string" }, { type: "number" }] } },
    });
    expect(normalized).toHaveProperty("properties", {
      ...unresolved,
      "0": { type: "string" },
      "1": { type: "number" },
    });
  });
});

function makeTool(parameters: TSchema, overrides: Partial<AnyAgentTool> = {}): AnyAgentTool {
  return {
    name: "test_tool",
    label: "Test Tool",
    description: "test",
    parameters,
    execute: vi.fn(),
    ...overrides,
  };
}

describe("normalizeToolParameters", () => {
  it("preserves before_tool_call wrapper metadata", () => {
    const source = makeTool(Type.Object({ value: Type.String() }));
    const hookContext = { agentId: "main", sessionId: "session-before-normalize" };
    const wrapped = wrapToolWithBeforeToolCallHook(source, hookContext);

    const normalized = normalizeToolParameters(wrapped);
    expect(isToolWrappedWithBeforeToolCallHook(normalized)).toBe(true);
    expect(getBeforeToolCallSourceTool(normalized)).toBe(source);
    expect(getBeforeToolCallHookContext(normalized)).toBe(hookContext);
  });

  it("leaves null arguments invalid when required params are nested in composite schemas", () => {
    const tool = makeTool(
      {
        type: "object",
        allOf: [
          {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        ],
      },
      { name: "query" },
    );

    const normalized = normalizeToolParameters(tool);

    expect(normalized.prepareArguments).toBeUndefined();
    expect(() =>
      validateToolArguments(normalized, {
        type: "toolCall",
        id: "call-1",
        name: "query",
        arguments: null as never,
      }),
    ).toThrow('Validation failed for tool "query"');
  });

  it("runs null arguments for parameterless tools through the agent loop without validation failure", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "wiki ok" }],
      details: { ok: true },
    });
    const normalized = normalizeToolParameters({
      name: "wiki_lint",
      label: "wiki_lint",
      description: "Lint wiki vault",
      parameters: { type: "object", properties: {}, required: [] },
      execute,
    });
    const tool = wrapToolWithBeforeToolCallHook(normalized, {
      agentId: "main",
      sessionKey: "e2e-null-args",
      loopDetection: { enabled: true },
    });
    const { messages, events, streamCalls } = await runToolCall(
      tool,
      {
        type: "toolCall",
        id: "call-null-args",
        name: "wiki_lint",
        arguments: null as never,
      },
      "lint the wiki",
    );

    expect(streamCalls).toBe(2);
    const executeCall = execute.mock.calls[0];
    expect(executeCall?.[0]).toBe("call-null-args");
    expect(executeCall?.[1]).toEqual({});
    expect(executeCall?.[2]).toBeUndefined();
    expect(typeof executeCall?.[3]).toBe("function");
    const toolResult = messages.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: "call-null-args",
      toolName: "wiki_lint",
      isError: false,
      content: [{ type: "text", text: "wiki ok" }],
    });
    expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
      type: "tool_execution_end",
      toolCallId: "call-null-args",
      toolName: "wiki_lint",
      isError: false,
    });
    expect(JSON.stringify(messages)).not.toContain("Validation failed for tool");
  });
});

function makeValidatedFileTool(name: "write" | "edit", execute: AnyAgentTool["execute"]) {
  return wrapToolParamValidation(makeTool({}, { name, execute }), REQUIRED_PARAM_GROUPS[name]);
}

describe("assertRequiredParams", () => {
  it("strips only the malformed terminal XML arg-value suffix", () => {
    expect(normalizeFileToolPathParam("echo test</arg_value>>")).toBe("echo test");
    expect(normalizeFileToolPathParam("echo test</arg_value>>>>>")).toBe("echo test");
    expect(normalizeFileToolPathParam("echo test</arg_value>")).toBe("echo test</arg_value>");
    expect(normalizeFileToolPathParam("echo </arg_value>> test")).toBe("echo </arg_value>> test");
  });

  it("rejects paths that become empty after malformed XML arg-value suffix stripping", async () => {
    const execute = vi.fn();
    const tool = makeValidatedFileTool("write", execute);

    await expect(tool.execute("id", { path: "</arg_value>>", content: "x" })).rejects.toThrow(
      /Missing required parameter: path/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves edit replacement payloads while cleaning the path", async () => {
    const execute = vi.fn(async (_id, args) => args);
    const tool = makeValidatedFileTool("edit", execute);

    const edits = [
      {
        oldText: "literal old</arg_value>>",
        newText: "literal new</arg_value>>",
      },
    ];
    await tool.execute("id", { path: "notes.docxodex</arg_value>>>", edits });

    expect(execute).toHaveBeenCalledWith("id", { path: "notes.docx", edits }, undefined, undefined);
  });

  it("enforces canonical path/content at runtime", async () => {
    const execute = vi.fn(async (_id, args) => args);
    const tool = makeValidatedFileTool("write", execute);

    await tool.execute("tool-1", { path: "foo.txt", content: "x" });
    expect(execute).toHaveBeenCalledWith(
      "tool-1",
      { path: "foo.txt", content: "x" },
      undefined,
      undefined,
    );

    await expect(tool.execute("tool-2", { content: "x" })).rejects.toThrow(
      "Missing required parameter: path (received: content). Supply correct parameters before retrying.",
    );
    await expect(tool.execute("tool-3", { path: "   ", content: "x" })).rejects.toThrow(
      "Missing required parameter: path (received: path=<empty-string>, content). Supply correct parameters before retrying.",
    );
    await expect(tool.execute("tool-4", {})).rejects.toThrow(
      "Missing required parameters: path, content. Supply correct parameters before retrying.",
    );
  });

  it("excludes null and undefined values from received hint", () => {
    expect(() =>
      assertRequiredParams(
        { path: "test.txt", content: null },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path\)[^,]/);
  });

  it("shows wrong-type values for present params that still fail validation", async () => {
    const tool = makeValidatedFileTool("write", vi.fn());
    await expect(
      tool.execute(
        "id",
        { path: "test.txt", content: { unexpected: true } },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow(/\(received: (?:path, content=<object>|content=<object>, path)\)/);
  });
});
