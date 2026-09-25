import { validateToolCall } from "@openclaw/llm-core/validation";
import { describe, expect, it } from "vitest";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import { projectRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

const detail = {
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: 50 }, (_, index) => [`field_${index}`, { type: "string" }]),
  ),
  required: ["field_0"],
  additionalProperties: false,
};
const batch = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        anyOf: ["page", "claim", "relationship"].map((kind) => ({
          type: "object",
          properties: { kind: { const: kind }, input: { $ref: "#/$defs/input" } },
          required: ["kind", "input"],
          additionalProperties: false,
        })),
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
  $defs: { input: detail },
};

describe("compact OpenAI tool references", () => {
  it.each(["$defs", "definitions"])("coerces tool calls without expanding %s", (table) => {
    const ref = (name: string) => ({ $ref: `#/${table}/${name}` });
    const schema = {
      type: "object",
      properties: { tags: ref("tags"), records: ref("records"), settings: ref("settings") },
      required: ["tags", "records", "settings"],
      [table]: {
        tags: { type: "array", items: { type: "string" } },
        records: { type: "array", items: ref("settings") },
        settings: {
          type: "object",
          properties: { enabled: { type: "boolean" }, count: { type: "integer" } },
          required: ["enabled", "count"],
        },
      },
    };
    const parameters = normalizeToolParameterSchema(schema, { modelProvider: "openai" });
    const before = structuredClone(parameters);
    const args = {
      tags: '["a","b"]',
      records: '[{"enabled":"true","count":"2"}]',
      settings: '{"enabled":"false","count":"3"}',
    };
    const input = structuredClone(args);
    expect(
      validateToolCall([{ name: "reference_probe", description: "", parameters }], {
        type: "toolCall",
        id: "reference-call",
        name: "reference_probe",
        arguments: args,
      }),
    ).toEqual({
      tags: ["a", "b"],
      records: [{ enabled: true, count: 2 }],
      settings: { enabled: false, count: 3 },
    });
    expect(args).toEqual(input);
    expect(parameters).toEqual(before);
    expect(parameters).toHaveProperty([table, "settings"]);
    expect(parameters).toHaveProperty("properties.tags.$ref", `#/${table}/tags`);
  });

  it.each(["root identifier", "nested definition table"])(
    "keeps host coercion through the inline fallback for %s",
    (shape) => {
      const settings = {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        ...(shape === "nested definition table" ? { $defs: { unused: { type: "string" } } } : {}),
      };
      const parameters = normalizeToolParameterSchema(
        {
          type: "object",
          properties: { settings: { $ref: "#/$defs/settings" } },
          $defs: { settings },
          ...(shape === "root identifier" ? { $id: "https://example.invalid/tool" } : {}),
        },
        { modelProvider: "openai" },
      );
      expect(JSON.stringify(parameters)).not.toContain('"$ref"');
      expect(
        validateToolCall([{ name: "fallback_probe", description: "", parameters }], {
          type: "toolCall",
          id: "fallback-call",
          name: "fallback_probe",
          arguments: { settings: '{"count":"2"}' },
        }),
      ).toEqual({ settings: { count: 2 } });
    },
  );

  it.each(["$defs", "definitions"])(
    "inlines malformed %s tables instead of preserving them",
    (key) => {
      const schema = {
        type: "object",
        properties: { value: { $ref: `#/${key}/0` } },
        [key]: [{ type: "string" }],
      };
      expect(normalizeToolParameterSchema(schema, { modelProvider: "openai" })).toEqual({
        type: "object",
        properties: { value: { type: "string" } },
      });
    },
  );

  it("drops unused definitions even when they contain references", () => {
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      $defs: {
        unused: { type: "object", properties: { next: { $ref: "#/$defs/large" } } },
        large: { ...detail, description: "Unused definition".repeat(400) },
      },
    };
    expect(normalizeToolParameterSchema(schema, { modelProvider: "openai" })).toEqual({
      type: "object",
      properties: schema.properties,
    });
  });

  it.each([false, true])("retains Responses payload inlining with strict=%s", (strict) => {
    const schema = {
      type: "object",
      properties: { value: { $ref: "#/$defs/value", description: "Value" } },
      required: ["value"],
      additionalProperties: false,
      $defs: { value: { type: "string", maxLength: 10 } },
    };
    const normalized = normalizeToolParameterSchema(schema, { modelProvider: "openai" });
    expect(normalized).toHaveProperty("properties.value.$ref", "#/$defs/value");
    const [tool] = convertResponsesToolPayload(
      [
        {
          name: "reference_probe",
          description: "Synthetic reference probe",
          parameters: normalized,
        },
      ],
      { strict },
    );
    expect(tool).toMatchObject({
      strict,
      parameters: {
        type: "object",
        properties: { value: { type: "string", maxLength: 10, description: "Value" } },
      },
    });
    expect(JSON.stringify(tool)).not.toContain('"$ref"');
    expect(tool?.parameters).not.toHaveProperty("$defs");
  });

  it("keeps batch types through shared normalization and Codex projection", () => {
    // Inlining crosses Codex's 5,000-byte limit and erases item types.
    expect(JSON.stringify(normalizeToolParameterSchema(batch)).length).toBeGreaterThan(5000);
    const normalized = normalizeToolParameterSchema(batch, { modelProvider: "openai" });
    const projected = projectRuntimeToolInputSchema(normalizeOpenAIStrictCompatSchema(normalized));
    expect(projected.violations).toEqual([]);
    expect(projected.schema).toMatchObject(batch);
    expect(JSON.stringify(projected.schema).length).toBeLessThan(5000);
    expect(batch.$defs.input).toBe(detail);
    expect(normalizeToolParameterSchema(batch, { modelProvider: "openai" })).toBe(normalized);
  });

  it.each([
    { modelProvider: "gemini" },
    { modelProvider: "anthropic" },
    { modelProvider: "openai", modelCompat: { toolSchemaProfile: "gemini" } },
    { modelProvider: "openai", modelCompat: { toolSchemaProfile: "llamacpp" } },
    { modelProvider: "openai", modelCompat: { unsupportedToolSchemaKeywords: ["$ref"] } },
    { modelProvider: "openai", modelCompat: { unsupportedToolSchemaKeywords: ["$defs"] } },
  ])("keeps provider fallback: %j", (options) => {
    const normalized = normalizeToolParameterSchema(batch, options);
    expect(normalized).not.toHaveProperty("$defs");
    expect(JSON.stringify(normalized)).not.toContain('"$ref"');
  });

  it("keeps root refs and unions on the existing inline path", () => {
    for (const schema of [
      { $ref: "#/$defs/input", $defs: { input: detail } },
      { anyOf: [{ $ref: "#/$defs/input" }], $defs: { input: detail } },
    ]) {
      expect(normalizeToolParameterSchema(schema, { modelProvider: "openai" })).toEqual(
        normalizeToolParameterSchema(schema),
      );
    }
  });

  it("inlines mixed OpenAPI refs rather than leaving dangling components", () => {
    const schema = {
      ...batch,
      properties: { ...batch.properties, extra: { $ref: "#/components/schemas/Extra" } },
      components: { schemas: { Extra: { type: "string" } } },
    };
    const normalized = normalizeToolParameterSchema(schema, { modelProvider: "openai" });
    expect(normalized).not.toHaveProperty("components");
    expect(normalized).toHaveProperty("properties.extra.type", "string");
    expect(JSON.stringify(normalized)).not.toContain('"$ref"');
  });

  it("preserves ref siblings, legacy definitions, and recursive refs", () => {
    const schema = {
      type: "object",
      properties: { node: { $ref: "#/definitions/node", description: "Root", maxProperties: 2 } },
      definitions: {
        node: {
          type: "object",
          properties: {
            next: { $ref: "#/definitions/node" },
            label: { type: "string", nullable: true },
          },
        },
      },
    };
    const normalized = normalizeToolParameterSchema(schema, { modelProvider: "openai" });
    expect(normalized).toHaveProperty("properties.node", schema.properties.node);
    expect(normalized).toHaveProperty("definitions.node.properties.next", {
      $ref: "#/definitions/node",
    });
    expect(normalized).toHaveProperty("definitions.node.properties.label.type", ["string", "null"]);
  });

  it.each([
    { $id: "https://example.invalid/schema", properties: {} },
    { $defs: { local: { type: "string" } }, properties: { label: { $ref: "#/$defs/local" } } },
    { properties: { label: { $ref: "#/$defs/missing" } } },
    { properties: { label: { $ref: "#/$defs/input", nullable: true } } },
  ])("keeps scoped or unresolved refs on the existing path: %j", (nested) => {
    const schema = {
      ...batch,
      properties: { ...batch.properties, extra: { type: "object", ...nested } },
    };
    expect(normalizeToolParameterSchema(schema, { modelProvider: "openai" })).toEqual(
      normalizeToolParameterSchema(schema),
    );
  });
});
