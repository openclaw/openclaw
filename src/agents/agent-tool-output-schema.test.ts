/**
 * Phase 11 — output_schema field on ToolSpec
 *
 * Tests covering:
 *   - Backcompat: tools without outputSchema compile and flow through unchanged
 *   - Schema pass-through: outputSchema is preserved in AnyAgentTool and descriptor
 *   - No-throw safety: capturePluginToolDescriptor never throws on malformed shapes
 *   - Adapter/catalog integration: capturePluginToolDescriptor wires outputSchema
 *     into ToolDescriptor.outputSchema (the plugin descriptor cache path)
 */

import { describe, expect, it } from "vitest";
import { capturePluginToolDescriptor } from "../plugins/tool-descriptor-cache.js";
import type { AnyAgentTool } from "./tools/common.js";

// ---------------------------------------------------------------------------
// Minimal stub factory — builds an AnyAgentTool-shaped object for tests.
// ---------------------------------------------------------------------------

function makeMinimalTool(overrides: Partial<AnyAgentTool> = {}): AnyAgentTool {
  return {
    name: "test_tool",
    label: "Test tool",
    description: "A test tool for unit tests.",
    parameters: { type: "object", properties: {} } as never,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Type-level: AnyAgentTool accepts outputSchema
// ---------------------------------------------------------------------------

describe("AnyAgentTool type — outputSchema field", () => {
  it("accepts a tool with no outputSchema (backcompat)", () => {
    const tool: AnyAgentTool = makeMinimalTool();
    // outputSchema is absent — no type error; runtime value is undefined
    expect(tool.outputSchema).toBeUndefined();
  });

  it("accepts a tool with outputSchema set to a plain object", () => {
    const schema = { type: "object", properties: { result: { type: "string" } } } as const;
    const tool: AnyAgentTool = makeMinimalTool({ outputSchema: schema });
    expect(tool.outputSchema).toEqual(schema);
  });

  it("accepts nested outputSchema with required array", () => {
    const schema = {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        data: { type: "object" },
      },
      required: ["ok"],
    } as never;
    const tool: AnyAgentTool = makeMinimalTool({ outputSchema: schema });
    expect(tool.outputSchema).toStrictEqual(schema);
  });

  it("preserves outputSchema identity when set", () => {
    const schema = { type: "string" } as never;
    const tool = makeMinimalTool({ outputSchema: schema });
    expect(tool.outputSchema).toBe(schema);
  });
});

// ---------------------------------------------------------------------------
// capturePluginToolDescriptor — backcompat (no outputSchema)
// ---------------------------------------------------------------------------

describe("capturePluginToolDescriptor — backcompat without outputSchema", () => {
  it("omits outputSchema from descriptor when tool has no outputSchema", () => {
    const tool = makeMinimalTool();
    const captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: false });
    expect(captured.descriptor.outputSchema).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(captured.descriptor, "outputSchema")).toBe(false);
  });

  it("preserves all other descriptor fields when no outputSchema is present", () => {
    const tool = makeMinimalTool({
      name: "my_tool",
      description: "Does something useful.",
    });
    const captured = capturePluginToolDescriptor({ pluginId: "myplugin", tool, optional: false });
    expect(captured.descriptor.name).toBe("my_tool");
    expect(captured.descriptor.description).toBe("Does something useful.");
    expect(captured.descriptor.inputSchema).toEqual({ type: "object", properties: {} });
    expect(captured.descriptor.owner).toEqual({ kind: "plugin", pluginId: "myplugin" });
  });

  it("handles tool with undefined outputSchema explicitly set", () => {
    const tool = makeMinimalTool({ outputSchema: undefined });
    const captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: false });
    expect(captured.descriptor.outputSchema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// capturePluginToolDescriptor — schema pass-through
// ---------------------------------------------------------------------------

describe("capturePluginToolDescriptor — outputSchema pass-through", () => {
  it("wires a flat outputSchema to the descriptor", () => {
    const schema = { type: "object", properties: { id: { type: "string" } } } as never;
    const tool = makeMinimalTool({ outputSchema: schema });
    const captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: false });
    expect(captured.descriptor.outputSchema).toEqual(schema);
  });

  it("wires a nested outputSchema to the descriptor", () => {
    const schema = {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        summary: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["ok"],
    } as never;
    const tool = makeMinimalTool({ outputSchema: schema });
    const captured = capturePluginToolDescriptor({ pluginId: "my-plugin", tool, optional: false });
    expect(captured.descriptor.outputSchema).toStrictEqual(schema);
  });

  it("preserves all other descriptor fields alongside outputSchema", () => {
    const schema = { type: "string" } as never;
    const tool = makeMinimalTool({
      name: "search_records",
      description: "Searches records.",
      outputSchema: schema,
    });
    const captured = capturePluginToolDescriptor({ pluginId: "search", tool, optional: false });
    expect(captured.descriptor.name).toBe("search_records");
    expect(captured.descriptor.description).toBe("Searches records.");
    expect(captured.descriptor.outputSchema).toEqual(schema);
  });

  it("wires outputSchema for an optional tool", () => {
    const schema = { type: "object" } as never;
    const tool = makeMinimalTool({ outputSchema: schema });
    const captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: true });
    expect(captured.descriptor.outputSchema).toEqual(schema);
    expect(captured.optional).toBe(true);
  });

  it("wires outputSchema with ownerOnly tool", () => {
    const schema = { type: "null" } as never;
    const tool = makeMinimalTool({ outputSchema: schema, ownerOnly: true });
    const captured = capturePluginToolDescriptor({ pluginId: "admin", tool, optional: false });
    expect(captured.descriptor.outputSchema).toEqual(schema);
    expect(captured.ownerOnly).toBe(true);
  });

  it("wires outputSchema alongside a title derived from label", () => {
    const schema = { type: "object" } as never;
    const tool = makeMinimalTool({ label: "My Awesome Tool", outputSchema: schema });
    const captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: false });
    expect(captured.descriptor.title).toBe("My Awesome Tool");
    expect(captured.descriptor.outputSchema).toEqual(schema);
  });

  it("wires outputSchema alongside a displaySummary", () => {
    const schema = { type: "string" } as never;
    const tool = makeMinimalTool({ displaySummary: "Returned text content", outputSchema: schema });
    const captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: false });
    expect(captured.displaySummary).toBe("Returned text content");
    expect(captured.descriptor.outputSchema).toEqual(schema);
  });
});

// ---------------------------------------------------------------------------
// capturePluginToolDescriptor — no-throw safety
// ---------------------------------------------------------------------------

describe("capturePluginToolDescriptor — no-throw safety", () => {
  it("does not throw when outputSchema is undefined", () => {
    expect(() => {
      capturePluginToolDescriptor({ pluginId: "demo", tool: makeMinimalTool(), optional: false });
    }).not.toThrow();
  });

  it("does not throw when outputSchema is a valid object", () => {
    const schema = { type: "object" } as never;
    expect(() => {
      capturePluginToolDescriptor({
        pluginId: "demo",
        tool: makeMinimalTool({ outputSchema: schema }),
        optional: false,
      });
    }).not.toThrow();
  });

  it("gracefully omits outputSchema when set to null (coerced via cast)", () => {
    // A plugin could return a malformed tool at runtime; the adapter must not throw.
    const tool = makeMinimalTool({ outputSchema: null as never });
    let captured: ReturnType<typeof capturePluginToolDescriptor> | undefined;
    expect(() => {
      captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: false });
    }).not.toThrow();
    expect(captured?.descriptor.outputSchema).toBeUndefined();
  });

  it("gracefully omits outputSchema when set to an array (malformed)", () => {
    const tool = makeMinimalTool({ outputSchema: [] as never });
    let captured: ReturnType<typeof capturePluginToolDescriptor> | undefined;
    expect(() => {
      captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: false });
    }).not.toThrow();
    expect(captured?.descriptor.outputSchema).toBeUndefined();
  });

  it("gracefully omits outputSchema when set to a string (malformed)", () => {
    const tool = makeMinimalTool({ outputSchema: "not-a-schema" as never });
    let captured: ReturnType<typeof capturePluginToolDescriptor> | undefined;
    expect(() => {
      captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: false });
    }).not.toThrow();
    expect(captured?.descriptor.outputSchema).toBeUndefined();
  });

  it("gracefully omits outputSchema when set to a number (malformed)", () => {
    const tool = makeMinimalTool({ outputSchema: 42 as never });
    let captured: ReturnType<typeof capturePluginToolDescriptor> | undefined;
    expect(() => {
      captured = capturePluginToolDescriptor({ pluginId: "demo", tool, optional: false });
    }).not.toThrow();
    expect(captured?.descriptor.outputSchema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adapter/catalog integration — round-trip through CachedPluginToolDescriptor
// ---------------------------------------------------------------------------

describe("capturePluginToolDescriptor — catalog adapter integration", () => {
  it("round-trips the complete tool contract with outputSchema intact", () => {
    const inputSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    } as never;
    const outputSchema = {
      type: "object",
      properties: {
        results: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
      },
      required: ["results", "total"],
    } as never;
    const tool = makeMinimalTool({
      name: "search_messages",
      label: "Search Messages",
      description: "Searches messages matching a query.",
      parameters: inputSchema,
      outputSchema,
    });

    const captured = capturePluginToolDescriptor({ pluginId: "lark-im", tool, optional: false });

    // The full ToolDescriptor contract is preserved.
    expect(captured.descriptor.name).toBe("search_messages");
    expect(captured.descriptor.title).toBe("Search Messages");
    expect(captured.descriptor.description).toBe("Searches messages matching a query.");
    expect(captured.descriptor.inputSchema).toEqual(inputSchema);
    expect(captured.descriptor.outputSchema).toEqual(outputSchema);
    expect(captured.descriptor.owner).toEqual({ kind: "plugin", pluginId: "lark-im" });
    expect(captured.descriptor.executor).toEqual({
      kind: "plugin",
      pluginId: "lark-im",
      toolName: "search_messages",
    });
    expect(captured.optional).toBe(false);
  });

  it("preserves that two descriptors are equal when outputSchema is the same object", () => {
    const outputSchema = { type: "object", properties: { id: { type: "string" } } } as never;
    const toolA = makeMinimalTool({ name: "list_items", outputSchema });
    const toolB = makeMinimalTool({ name: "list_items", outputSchema });

    const capturedA = capturePluginToolDescriptor({ pluginId: "p", tool: toolA, optional: false });
    const capturedB = capturePluginToolDescriptor({ pluginId: "p", tool: toolB, optional: false });

    expect(capturedA.descriptor.outputSchema).toEqual(capturedB.descriptor.outputSchema);
  });

  it("distinctly captures two tools with different outputSchemas", () => {
    const schemaA = { type: "string" } as never;
    const schemaB = { type: "integer" } as never;
    const toolA = makeMinimalTool({ name: "tool_a", outputSchema: schemaA });
    const toolB = makeMinimalTool({ name: "tool_b", outputSchema: schemaB });

    const capturedA = capturePluginToolDescriptor({ pluginId: "p", tool: toolA, optional: false });
    const capturedB = capturePluginToolDescriptor({ pluginId: "p", tool: toolB, optional: false });

    expect(capturedA.descriptor.outputSchema).toEqual({ type: "string" });
    expect(capturedB.descriptor.outputSchema).toEqual({ type: "integer" });
    expect(capturedA.descriptor.outputSchema).not.toEqual(capturedB.descriptor.outputSchema);
  });
});
