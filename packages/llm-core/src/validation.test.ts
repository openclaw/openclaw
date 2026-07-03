// LLM Core tests cover validation behavior.
import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import { validateToolArguments, validateToolCall } from "./validation.js";

const decimalTool = {
  name: "decimal-tool",
  description: "test tool",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number" },
      count: { type: "integer" },
    },
    required: ["amount", "count"],
    additionalProperties: false,
  },
} as Tool;

describe("validateToolArguments", () => {
  it("coerces strict decimal numeric strings for plain JSON schemas", () => {
    expect(
      validateToolArguments(decimalTool, {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "1e3", count: "+3" },
      }),
    ).toEqual({ amount: 1000, count: 3 });
  });

  it("rejects non-decimal numeric strings for plain JSON schemas", () => {
    expect(() =>
      validateToolArguments(decimalTool, {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "0x10", count: "0b10" },
      }),
    ).toThrow(/Validation failed for tool "decimal-tool"/);
  });

  it("preserves null in anyOf [{type: string}, {type: null}] without coercing to empty string (#96716)", () => {
    const tool = {
      name: "nullable-tool",
      description: "test tool",
      parameters: {
        type: "object",
        properties: {
          insight_id: { anyOf: [{ type: "string" }, { type: "null" }] },
          cluster_name: { type: "string" },
        },
        required: ["cluster_name"],
        additionalProperties: false,
      },
    } as Tool;

    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "nullable-tool",
        arguments: { insight_id: null, cluster_name: "testenv" },
      }),
    ).toEqual({ insight_id: null, cluster_name: "testenv" });
  });
});

describe("validateToolCall", () => {
  it("resolves tool names case-insensitively", () => {
    expect(
      validateToolCall([decimalTool], {
        type: "toolCall",
        id: "call-case",
        name: "Decimal-Tool",
        arguments: { amount: "2.5", count: "4" },
      }),
    ).toEqual({ amount: 2.5, count: 4 });
  });

  it("maps Claude Code tool aliases to OpenClaw runtime tool names", () => {
    const findTool = {
      name: "find",
      description: "find files",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
        },
        required: ["pattern"],
      },
    } as Tool;
    const memorySearchTool = {
      name: "memory_search",
      description: "search memory",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    } as Tool;

    expect(
      validateToolCall([findTool], {
        type: "toolCall",
        id: "call-glob",
        name: "Glob",
        arguments: { pattern: "**/*.ts" },
      }),
    ).toEqual({ pattern: "**/*.ts" });
    expect(
      validateToolCall([memorySearchTool], {
        type: "toolCall",
        id: "call-knowledge",
        name: "KnowledgeSearch",
        arguments: { query: "launch notes" },
      }),
    ).toEqual({ query: "launch notes" });
  });

  it("reports available tools when no exact, case-insensitive, or alias match exists", () => {
    expect(() =>
      validateToolCall([decimalTool, arrayTool], {
        type: "toolCall",
        id: "call-missing",
        name: "MissingTool",
        arguments: {},
      }),
    ).toThrow("Tool MissingTool not found. Available tools: decimal-tool, array-tool");
  });

  it("does not use ambiguous normalized tool-name matches", () => {
    const underscoreTool = {
      name: "foo_bar",
      description: "underscore variant",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    } as Tool;
    const dashTool = {
      name: "foo-bar",
      description: "dash variant",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    } as Tool;

    expect(
      validateToolCall([underscoreTool, dashTool], {
        type: "toolCall",
        id: "call-exact",
        name: "foo-bar",
        arguments: {},
      }),
    ).toEqual({});
    expect(() =>
      validateToolCall([underscoreTool, dashTool], {
        type: "toolCall",
        id: "call-ambiguous",
        name: "Foo-Bar",
        arguments: {},
      }),
    ).toThrow("Tool Foo-Bar not found. Available tools: foo_bar, foo-bar");
  });
});

const arrayTool = {
  name: "array-tool",
  description: "test tool with array param",
  parameters: {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["tags"],
    additionalProperties: false,
  },
} as Tool;

const objectTool = {
  name: "object-tool",
  description: "test tool with object param",
  parameters: {
    type: "object",
    properties: {
      config: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          retries: { type: "number" },
        },
      },
    },
    required: ["config"],
    additionalProperties: false,
  },
} as Tool;

describe("validateToolArguments — stringified JSON coercion", () => {
  it("coerces stringified JSON array to array for plain JSON schemas", () => {
    expect(
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-2",
        name: "array-tool",
        arguments: { tags: '["test","debug"]' },
      }),
    ).toEqual({ tags: ["test", "debug"] });
  });

  it("coerces stringified JSON object to object for plain JSON schemas", () => {
    expect(
      validateToolArguments(objectTool, {
        type: "toolCall",
        id: "call-3",
        name: "object-tool",
        arguments: { config: '{"enabled":true,"retries":3}' },
      }),
    ).toEqual({ config: { enabled: true, retries: 3 } });
  });

  it("passes through valid arrays unchanged", () => {
    expect(
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-4",
        name: "array-tool",
        arguments: { tags: ["already", "array"] },
      }),
    ).toEqual({ tags: ["already", "array"] });
  });

  it("passes through valid objects unchanged", () => {
    expect(
      validateToolArguments(objectTool, {
        type: "toolCall",
        id: "call-5",
        name: "object-tool",
        arguments: { config: { enabled: false, retries: 1 } },
      }),
    ).toEqual({ config: { enabled: false, retries: 1 } });
  });

  it("rejects invalid JSON string for array param", () => {
    expect(() =>
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-6",
        name: "array-tool",
        arguments: { tags: "not-json" },
      }),
    ).toThrow(/Validation failed for tool "array-tool"/);
  });

  it("rejects JSON string that is wrong type for array param", () => {
    expect(() =>
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-7",
        name: "array-tool",
        arguments: { tags: '{"not":"array"}' },
      }),
    ).toThrow(/Validation failed for tool "array-tool"/);
  });

  it("skips JSON coercion for oversized array string", () => {
    const hugeArray = JSON.stringify(Array.from({ length: 100_000 }, (_, i) => i));
    expect(hugeArray.length).toBeGreaterThan(64 * 1024);
    expect(() =>
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-8",
        name: "array-tool",
        arguments: { tags: hugeArray },
      }),
    ).toThrow(/Validation failed for tool "array-tool"/);
  });

  it("skips JSON coercion for oversized object string", () => {
    const hugeObj = JSON.stringify({ data: "x".repeat(70_000) });
    expect(hugeObj.length).toBeGreaterThan(64 * 1024);
    expect(() =>
      validateToolArguments(objectTool, {
        type: "toolCall",
        id: "call-9",
        name: "object-tool",
        arguments: { config: hugeObj },
      }),
    ).toThrow(/Validation failed for tool "object-tool"/);
  });
});
