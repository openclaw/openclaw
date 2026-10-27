import type { Tool } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { normalizeMcpToolCatalog } from "./mcp-tool-metadata.js";

function tool(name: string, overrides: Partial<Tool> = {}): Tool {
  return { name, inputSchema: { type: "object" }, ...overrides };
}

function catalog(tools: Tool[], classify?: Parameters<typeof normalizeMcpToolCatalog>[2]) {
  return normalizeMcpToolCatalog(tools, createMcpJsonSchemaValidator(), classify);
}

const draft2020 = "https://json-schema.org/draft/2020-12/schema";

it.each([undefined, { error: "ambiguous contact" }])(
  "accepts tool errors without requiring the success output schema (%j)",
  (structuredContent) => {
    const validate = catalog([
      tool("get_conversation", { outputSchema: { type: "object", required: ["messages"] } }),
    ]).metadata.validatorForCall("get_conversation")!;
    expect(() =>
      validate({
        isError: true,
        content: [{ type: "text", text: "Call list_conversations, then pass the chosen chat_id." }],
        structuredContent,
      }),
    ).not.toThrow();
  },
);

function referencedOutput(id: string, ref = id, $schema?: string) {
  const outputSchema = {
    type: "object" as const,
    $id: "https://schema.example/root",
    definitions: { value: { $id: id, type: "string" } },
    properties: { value: { $ref: ref } },
    required: ["value"],
    ...($schema ? { $schema } : {}),
  };
  return catalog([tool("referenced", { outputSchema })]).metadata.validatorForCall("referenced")!;
}

it.each([
  ["IDN hosts", "https://bücher.example/value", "https://xn--bcher-kva.example/value"],
  ["relative references", "child", "./child"],
  ["local fragments", "#value", "#value"],
  ["reserved path escapes", "a%3Ab", "a%3Ab"],
  ["draft-2020 embedded resources", "value", "./value", draft2020],
])("validates tool output schemas with %s", (_label, id, ref, $schema?: string) => {
  const validate = referencedOutput(id, ref, $schema);
  expect(() => validate({ content: [], structuredContent: { value: "ok" } })).not.toThrow();
  expect(() => validate({ content: [], structuredContent: { value: 1 } })).toThrow(
    "Structured content does not match the tool's output schema",
  );
});

it("keeps nested hostname escapes distinct when resolving tool output schemas", () => {
  const validate = createMcpJsonSchemaValidator().getValidator({
    $id: "https://schema.example/root",
    definitions: {
      encoded: { $id: "https://127%252e0%252e0%252e1/value", const: "encoded" },
      plain: { $id: "https://127.0.0.1/value", const: "plain" },
    },
    $ref: "https://127%252e0%252e0%252e1/value",
  });
  expect([validate("encoded").valid, validate("plain").valid]).toEqual([true, false]);
});

it.each([
  ["encoded scheme delimiters", "%2f%2fschema.example:/value", "URI scheme is malformed"],
  ["invalid IPv6", "https://[1:2:3::4::5]/value", "URI host is malformed"],
  ["malformed percent escapes", "https://schema.example/%ZZ", "malformed percent-encoding"],
])("rejects %s in tool output schema references", (_label, ref, error) => {
  expect(() => referencedOutput(ref)).toThrow(error);
});

it.for([
  [tool("duplicate"), tool(" duplicate ")],
  [
    tool(" task ", { execution: { taskSupport: "optional" } }),
    tool("task", { execution: { taskSupport: "required" } }),
  ],
])("rejects canonical collisions: %j", (colliding) => {
  const normalized = catalog([...colliding, tool("healthy")]);

  expect(normalized.tools.map((entry) => entry.name)).toEqual(["healthy"]);
  expect(normalized.deniedTools).toEqual([]);
  expect(normalized.excludedTools.map((entry) => entry.name)).toEqual(
    colliding.map((entry) => entry.name.trim()),
  );
  expect(normalized.metadata.validatorForCall(colliding[0]?.name.trim() ?? "")).toBeUndefined();
});

it("filters excluded tools before compiling their output schemas", () => {
  const normalized = catalog(
    [
      tool("healthy", { outputSchema: { type: "object" } }),
      tool("excluded", { outputSchema: { type: "object", $ref: "#/$defs/Missing" } }),
      tool("task_only", { execution: { taskSupport: "required" } }),
    ],
    (toolName) => (toolName === "excluded" ? "exclude" : "include"),
  );

  expect(normalized.tools.map((entry) => entry.name)).toEqual(["healthy"]);
  expect(normalized.excludedTools.map((entry) => entry.name)).toEqual(["excluded", "task_only"]);
  expect(normalized.metadata.validatorForCall("healthy")).toBeTypeOf("function");
  expect(normalized.metadata.validatorForCall("excluded")).toBeUndefined();
});
