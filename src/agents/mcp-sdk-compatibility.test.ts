import { expect, it } from "vitest";
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
function rejectTools(tool: Parameters<typeof toolResult>[0]) {
  const convert = () => toolsResult(toolResult(tool));
  expect(convert).toThrow(McpSdkCompatibilityError);
  expect(convert).toThrow(
    expect.objectContaining({ code: "MCP_SDK_RESULT_UNREPRESENTABLE", method: "tools/list" }),
  );
}

it("preserves complete v1 payloads, metadata, schemas, and cursors", () => {
  const call = {
    content: [{ type: "text" as const, text: "x", _meta: { source: "x" } }],
    structuredContent: { nested: [false, null, { value: 42 }] },
    isError: false,
    _meta: { result: { uri: "ui://x" } },
  };
  expect(callResult(call)).toStrictEqual(call);
  const tools = {
    ...toolResult({
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, value: [{ type: "string" }] },
      },
      outputSchema: { type: "object", properties: { result: { type: "number" } } },
      _meta: { tool: true },
    }),
    nextCursor: "next/page",
    ttlMs: 123,
    cacheScope: "private" as const,
    _meta: { page: 1 },
  };
  expect(toolsResult(tools)).toStrictEqual(tools);
  const templates = {
    resourceTemplates: [{ name: "x", uriTemplate: "x://{name}", _meta: { source: 1 } }],
    nextCursor: "templates/2",
    _meta: { page: 1 },
  };
  expect(templatesResult(templates)).toStrictEqual(templates);
  const resource = { uri: "x://x", text: "x", _meta: { source: 1 } };
  const content = { type: "resource" as const, resource };
  const prompt = {
    description: "x",
    messages: [{ role: "user" as const, content }],
    _meta: { prompt: [1, 2] },
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

it("rejects nested fields that a v1 schema would silently strip", () => {
  const content = {
    type: "text" as const,
    text: "answer",
    "fixture/extension": { meaningful: true },
  };
  expect(() => callResult({ content: [content] })).toThrow(McpSdkCompatibilityError);
});

it.each([
  ...[false, null, 1, "schema"].map((value) => ({
    inputSchema: { type: "object" as const, properties: { value } },
  })),
  ...[
    {},
    { type: "string" },
    { type: ["object", "null"] },
    { type: "object", properties: false },
    { type: "object", required: false },
    { type: "object", properties: { result: false } },
  ].map((outputSchema) => ({ outputSchema })),
])("rejects schemas outside the published v1 shape (%j)", rejectTools);
