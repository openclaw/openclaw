// LLM Core tests cover validation behavior.
import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import { validateToolArguments } from "./validation.js";

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

  const tagsTool = {
    name: "tags-tool",
    description: "test tool",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
        meta: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["content"],
      additionalProperties: false,
    },
  } as Tool;

  it("coerces JSON-stringified array parameters (issue #96916)", () => {
    expect(
      validateToolArguments(tagsTool, {
        type: "toolCall",
        id: "call-1",
        name: "tags-tool",
        arguments: { content: "test memory", tags: '["test","debug"]' },
      }),
    ).toEqual({ content: "test memory", tags: ["test", "debug"] });
  });

  it("coerces JSON-stringified object parameters", () => {
    expect(
      validateToolArguments(tagsTool, {
        type: "toolCall",
        id: "call-2",
        name: "tags-tool",
        arguments: { content: "x", meta: '{"a":"b"}' },
      }),
    ).toEqual({ content: "x", meta: { a: "b" } });
  });

  it("leaves ordinary string values untouched", () => {
    expect(
      validateToolArguments(tagsTool, {
        type: "toolCall",
        id: "call-3",
        name: "tags-tool",
        arguments: { content: "hello world" },
      }),
    ).toEqual({ content: "hello world" });
  });
});
