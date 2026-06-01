import { Type } from "typebox";
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

const nullableTypeBoxTool = {
  name: "nullable-typebox-tool",
  description: "test nullable TypeBox tool",
  parameters: Type.Object({
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    toolsAllow: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
    nested: Type.Optional(
      Type.Object({
        sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
    ),
  }),
} satisfies Tool;

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

  it("preserves explicit null values accepted by TypeBox unions", () => {
    expect(
      validateToolArguments(nullableTypeBoxTool, {
        type: "toolCall",
        id: "call-1",
        name: "nullable-typebox-tool",
        arguments: {
          agentId: null,
          toolsAllow: null,
          nested: { sessionKey: null },
        },
      }),
    ).toEqual({
      agentId: null,
      toolsAllow: null,
      nested: { sessionKey: null },
    });
  });
});
