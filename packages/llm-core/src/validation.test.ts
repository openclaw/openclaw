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

  it("skips unreadable sibling tool names during tool-call lookup", () => {
    const hostileTool = {
      get name(): string {
        throw new Error("tool name exploded");
      },
      description: "hostile sibling",
      parameters: { type: "object", properties: {} },
    } as Tool;

    expect(
      validateToolCall([hostileTool, decimalTool], {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "4", count: "2" },
      }),
    ).toEqual({ amount: 4, count: 2 });
  });

  it("reports unreadable parameter schemas as validation failures", () => {
    const hostileTool = {
      name: "hostile-tool",
      description: "hostile params",
      get parameters(): Tool["parameters"] {
        throw new Error("parameters exploded");
      },
    } as Tool;

    expect(() =>
      validateToolArguments(hostileTool, {
        type: "toolCall",
        id: "call-1",
        name: "hostile-tool",
        arguments: {},
      }),
    ).toThrow(/Validation failed for tool "hostile-tool": unable to read parameter schema/);
  });
});
