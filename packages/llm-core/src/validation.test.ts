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

  it("reports unreadable nested schema maps before TypeBox traversal", () => {
    const unreadableProperties = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("llm properties ownKeys exploded");
        },
      },
    );
    const tool = {
      name: "hostile-tool",
      description: "test tool",
      parameters: {
        type: "object",
        properties: unreadableProperties,
        additionalProperties: { type: "number" },
      },
    } as unknown as Tool;

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "hostile-tool",
        arguments: { amount: "42" },
      }),
    ).toThrow(
      'Unsupported tool schema for "hostile-tool": unreadable schema at parameters.properties',
    );
  });

  it("reports non-enumerable unreadable schema keyword accessors", () => {
    const parameters = {
      type: "object",
    };
    Object.defineProperty(parameters, "properties", {
      enumerable: false,
      get() {
        throw new Error("llm non-enumerable properties exploded");
      },
    });
    const tool = {
      name: "non-enumerable-hostile-tool",
      description: "test tool",
      parameters,
    } as unknown as Tool;

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "non-enumerable-hostile-tool",
        arguments: {},
      }),
    ).toThrow(
      'Unsupported tool schema for "non-enumerable-hostile-tool": unreadable schema at parameters.properties',
    );
  });

  it("reports unreadable root schemas before TypeBox traversal", () => {
    const unreadableParameters = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("llm root ownKeys exploded");
        },
      },
    );
    const tool = {
      name: "root-hostile-tool",
      description: "test tool",
      parameters: unreadableParameters,
    } as unknown as Tool;

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "root-hostile-tool",
        arguments: {},
      }),
    ).toThrow('Unsupported tool schema for "root-hostile-tool": unreadable schema at parameters');
  });

  it("reports unreadable array schema items before TypeBox traversal", () => {
    const unreadableAnyOf = [{ type: "string" }];
    Object.defineProperty(unreadableAnyOf, "0", {
      enumerable: true,
      get() {
        throw new Error("llm anyOf item exploded");
      },
    });
    const tool = {
      name: "array-hostile-tool",
      description: "test tool",
      parameters: {
        type: "object",
        anyOf: unreadableAnyOf,
      },
    } as unknown as Tool;

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "array-hostile-tool",
        arguments: {},
      }),
    ).toThrow(
      'Unsupported tool schema for "array-hostile-tool": unreadable schema at parameters.anyOf.0',
    );
  });

  it("bounds schema readability inspection before TypeBox traversal", () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 1001; index += 1) {
      properties[`field_${index}`] = { type: "string" };
    }
    const tool = {
      name: "wide-hostile-tool",
      description: "test tool",
      parameters: {
        type: "object",
        properties,
      },
    } as unknown as Tool;

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "wide-hostile-tool",
        arguments: {},
      }),
    ).toThrow(
      'Unsupported tool schema for "wide-hostile-tool": schema field count exceeds inspection budget at parameters.properties',
    );
  });

  it("uses the tool call name when schema error reporting cannot read tool metadata", () => {
    const unreadableParameters = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("llm root ownKeys exploded");
        },
      },
    );
    const tool = {
      description: "test tool",
      parameters: unreadableParameters,
    } as unknown as Tool;
    Object.defineProperty(tool, "name", {
      enumerable: true,
      get() {
        throw new Error("tool name unavailable");
      },
    });

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "fallback-tool-name",
        arguments: {},
      }),
    ).toThrow('Unsupported tool schema for "fallback-tool-name": unreadable schema at parameters');
  });

  it("reports unreadable parameter accessors before TypeBox traversal", () => {
    const tool = {
      name: "accessor-hostile-tool",
      description: "test tool",
    } as unknown as Tool;
    Object.defineProperty(tool, "parameters", {
      enumerable: true,
      get() {
        throw new Error("tool parameters unavailable");
      },
    });

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "accessor-hostile-tool",
        arguments: {},
      }),
    ).toThrow(
      'Unsupported tool schema for "accessor-hostile-tool": unreadable schema at parameters',
    );
  });
});
