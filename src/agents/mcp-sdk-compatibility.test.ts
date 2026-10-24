import { describe, expect, it } from "vitest";
import {
  McpSdkCompatibilityError,
  toLegacyMcpCallToolResult as callResult,
  toLegacyMcpGetPromptResult as promptResult,
  toLegacyMcpListResourceTemplatesResult as templatesResult,
  toLegacyMcpListToolsResult as toolsResult,
} from "./mcp-sdk-compatibility.js";

function toolResult(tool: Partial<Parameters<typeof toolsResult>[0]["tools"][number]>) {
  return { tools: [{ name: "fixture", inputSchema: { type: "object" as const }, ...tool }] };
}

describe("published MCP result compatibility", () => {
  it("preserves complete v1 payloads, metadata, schemas, and cursors", () => {
    const call = {
      content: [{ type: "text" as const, text: "answer", _meta: { source: "fixture" } }],
      structuredContent: { nested: [false, null, { value: 42 }] },
      isError: false,
      _meta: { "fixture/result": { uri: "ui://fixture" } },
    };
    expect(callResult(call)).toStrictEqual(call);
    const tools = {
      ...toolResult({
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        _meta: { "fixture/tool": true },
      }),
      nextCursor: "next/page",
      _meta: { page: 1 },
    };
    expect(toolsResult(tools)).toStrictEqual(tools);
    const templates = {
      resourceTemplates: [{ name: "fixture", uriTemplate: "memo://{name}", _meta: { source: 1 } }],
      nextCursor: "templates/2",
      _meta: { page: 1 },
    };
    expect(templatesResult(templates)).toStrictEqual(templates);
    const prompt = {
      description: "fixture prompt",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "resource" as const,
            resource: { uri: "memo://fixture", text: "value", _meta: { source: 1 } },
          },
        },
      ],
      _meta: { "fixture/prompt": [1, 2] },
    };
    expect(promptResult(prompt)).toStrictEqual(prompt);
  });

  it.each([null, false, 42, "value", [1, 2]].map((value) => ({ value })))(
    "rejects non-object structured content (%j) explicitly",
    ({ value }) => {
      expect(() => callResult({ content: [], structuredContent: value })).toThrow(
        McpSdkCompatibilityError,
      );
    },
  );

  it.each([true, false, null, 1, "schema"].map((value) => ({ value })))(
    "rejects scalar schema properties (%j) without changing the schema",
    ({ value }) => {
      expect(() =>
        toolsResult(toolResult({ inputSchema: { type: "object", properties: { value } } })),
      ).toThrow(
        expect.objectContaining({
          code: "MCP_SDK_RESULT_UNREPRESENTABLE",
          method: "tools/list",
        }),
      );
    },
  );

  it("preserves array-valued schema properties and result extensions accepted by v1", () => {
    const result = {
      ...toolResult({
        inputSchema: { type: "object", properties: { value: [{ type: "string" }] } },
        outputSchema: { type: "object", properties: { result: { type: "number" } } },
      }),
      ttlMs: 123,
      cacheScope: "private" as const,
      _meta: { source: "fixture" },
    };
    expect(toolsResult(result)).toStrictEqual(result);
    expect(() =>
      toolsResult(toolResult({ outputSchema: { type: "object", properties: { result: false } } })),
    ).toThrow(McpSdkCompatibilityError);
  });

  it("rejects nested fields that a v1 schema would silently strip", () => {
    const content = {
      type: "text" as const,
      text: "answer",
      "fixture/extension": { meaningful: true },
    };
    expect(() => callResult({ content: [content] })).toThrow(McpSdkCompatibilityError);
  });

  it.each([
    {},
    { type: "string" },
    { type: ["object", "null"] },
    { type: "object", properties: false },
    { type: "object", required: false },
  ])("rejects an output schema outside the published v1 shape (%j)", (outputSchema) => {
    expect(() => toolsResult(toolResult({ outputSchema }))).toThrow(
      expect.objectContaining({
        code: "MCP_SDK_RESULT_UNREPRESENTABLE",
        method: "tools/list",
      }),
    );
  });
});
