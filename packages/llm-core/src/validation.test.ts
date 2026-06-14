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

  it("reports unreadable plain JSON schema fields as schema errors", () => {
    const unreadableProperties = new Proxy<Record<string, unknown>>(
      {
        amount: { type: "number" },
      },
      {
        ownKeys() {
          throw new Error("schema properties exploded");
        },
      },
    );
    const tool = {
      name: "unreadable-schema-tool",
      description: "test tool",
      parameters: {
        type: "object",
        properties: unreadableProperties,
      },
    } as unknown as Tool;

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "unreadable-schema-tool",
        arguments: { amount: "1" },
      }),
    ).toThrow(/Invalid parameter schema for tool "unreadable-schema-tool"/);
  });
});
