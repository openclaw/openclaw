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

  it("reports unreadable tool parameter schemas as unsupported", () => {
    const hostileTool = {
      name: "hostile-tool",
      description: "test tool",
      get parameters() {
        throw new Error("parameters getter exploded");
      },
    } as Tool;

    expect(() =>
      validateToolArguments(hostileTool, {
        type: "toolCall",
        id: "call-1",
        name: "hostile-tool",
        arguments: {},
      }),
    ).toThrow(/Unsupported tool schema for "hostile-tool": unreadable schema at parameters/);
  });

  it("reports unreadable nested JSON schemas as unsupported", () => {
    const properties: Record<string, unknown> = {};
    Object.defineProperty(properties, "amount", {
      enumerable: true,
      get() {
        throw new Error("schema properties exploded");
      },
    });
    const hostileTool = {
      name: "hostile-tool",
      description: "test tool",
      parameters: {
        type: "object",
        properties,
      },
    } as Tool;

    expect(() =>
      validateToolArguments(hostileTool, {
        type: "toolCall",
        id: "call-1",
        name: "hostile-tool",
        arguments: { amount: "12" },
      }),
    ).toThrow(
      /Unsupported tool schema for "hostile-tool": unreadable schema at parameters\.properties\.amount/,
    );
  });
});
