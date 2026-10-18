import { validateToolCall } from "@openclaw/llm-core/validation";
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { normalizeToolParameterSchema as normalize } from "./agent-tools-parameter-schema.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import { projectRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

const openai = { modelProvider: "openai" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
const reference = (name: string, table = "$defs") => ({ $ref: `#/${table}/${name}` });
function defined(name: string, definitions: unknown, table = "$defs", target = name) {
  return { ...object({ [name]: reference(target, table) }), [table]: definitions };
}
function validate(parameters: TSchema, args: Record<string, unknown>) {
  return validateToolCall([{ name: "probe", description: "", parameters }], {
    type: "toolCall",
    id: "call",
    name: "probe",
    arguments: args,
  });
}
function closed(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { ...object(properties), required, additionalProperties: false };
}
const detail = closed(
  Object.fromEntries(
    Array.from({ length: 50 }, (_, index) => [`field_${index}`, { type: "string" }]),
  ),
  ["field_0"],
);
const variants = ["page", "claim", "relationship"].map((kind) =>
  closed({ kind: { const: kind }, input: reference("input") }),
);
const batch = {
  ...closed({ items: { type: "array", items: { anyOf: variants } } }),
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
    const parameters = normalize(schema, openai);
    const before = structuredClone(parameters);
    const args = {
      tags: '["a","b"]',
      records: '[{"enabled":"true","count":"2"}]',
      settings: '{"enabled":"false","count":"3"}',
    };
    const input = structuredClone(args);
    expect(validate(parameters, args)).toEqual({
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
      const parameters = normalize(
        {
          ...defined("settings", { settings }),
          ...(shape === "root identifier" ? { $id: "https://example.invalid/tool" } : {}),
        },
        openai,
      );
      expect(JSON.stringify(parameters)).not.toContain('"$ref"');
      expect(validate(parameters, { settings: '{"count":"2"}' })).toEqual({
        settings: { count: 2 },
      });
    },
  );

  it("inlines malformed and encoded references and removes unused definitions", () => {
    const value = object({ limit: { type: "number" } });
    const stringValue = object({ value: { type: "string" } });
    for (const table of ["$defs", "definitions"]) {
      expect(normalize(defined("value", [{ type: "string" }], table, "0"), openai)).toEqual(
        stringValue,
      );
    }
    expect(
      normalize(
        {
          ...object({ value: { type: "string" } }),
          $defs: {
            unused: object({ next: reference("large") }),
            large: { ...detail, description: "Unused definition".repeat(400) },
          },
        },
        openai,
      ),
    ).toEqual(stringValue);
    for (const options of [
      { modelProvider: "google", modelId: "gemini-2.5-pro" },
      { modelProvider: "anthropic", modelId: "claude-sonnet-4-6" },
    ]) {
      for (const ref of [
        "#/definitions/Partial<Filter>",
        "#/definitions/Partial%3CFilter%3E",
        "#%2Fdefinitions%2FPartial%3CFilter%3E",
      ]) {
        const schema = {
          ...object({ filter: { $ref: ref } }),
          required: ["filter"],
          definitions: { "Partial<Filter>": value },
        };
        expect(normalize(schema, options)).toEqual({
          ...object({ filter: value }),
          required: ["filter"],
        });
      }
    }
  });

  it.each([false, true])("retains Responses payload inlining with strict=%s", (strict) => {
    const schema = {
      type: "object",
      properties: { value: { $ref: "#/$defs/value", description: "Value" } },
      required: ["value"],
      additionalProperties: false,
      $defs: { value: { type: "string", maxLength: 10 } },
    };
    const normalized = normalize(schema, openai);
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
    expect(JSON.stringify(normalize(batch)).length).toBeGreaterThan(5000);
    const normalized = normalize(batch, openai);
    const projected = projectRuntimeToolInputSchema(normalizeOpenAIStrictCompatSchema(normalized));
    expect(projected.violations).toEqual([]);
    expect(projected.schema).toMatchObject(batch);
    expect(JSON.stringify(projected.schema).length).toBeLessThan(5000);
    expect(batch.$defs.input).toBe(detail);
    expect(normalize(batch, openai)).toBe(normalized);
  });

  it.each([
    { modelProvider: "gemini" },
    { modelProvider: "anthropic" },
    { modelProvider: "openai", modelCompat: { toolSchemaProfile: "gemini" } },
    { modelProvider: "openai", modelCompat: { toolSchemaProfile: "llamacpp" } },
    { modelProvider: "openai", modelCompat: { unsupportedToolSchemaKeywords: ["$ref"] } },
    { modelProvider: "openai", modelCompat: { unsupportedToolSchemaKeywords: ["$defs"] } },
  ])("keeps provider fallback: %j", (options) => {
    const normalized = normalize(batch, options);
    expect(normalized).not.toHaveProperty("$defs");
    expect(JSON.stringify(normalized)).not.toContain('"$ref"');
  });

  it("inlines mixed OpenAPI refs rather than leaving dangling components", () => {
    const schema = {
      ...batch,
      properties: { ...batch.properties, extra: { $ref: "#/components/schemas/Extra" } },
      components: { schemas: { Extra: { type: "string" } } },
    };
    const normalized = normalize(schema, openai);
    expect(normalized).not.toHaveProperty("components");
    expect(normalized).toHaveProperty("properties.extra.type", "string");
    expect(JSON.stringify(normalized)).not.toContain('"$ref"');
  });

  it("preserves ref siblings, legacy definitions, and recursive refs", () => {
    const schema = {
      ...defined(
        "node",
        {
          node: object({
            next: reference("node", "definitions"),
            label: { type: "string", nullable: true },
          }),
        },
        "definitions",
      ),
      properties: {
        node: { ...reference("node", "definitions"), description: "Root", maxProperties: 2 },
      },
    };
    const normalized = normalize(schema, openai);
    expect(normalized).toHaveProperty("properties.node", schema.properties.node);
    expect(normalized).toHaveProperty("definitions.node.properties.next", {
      $ref: "#/definitions/node",
    });
    expect(normalized).toHaveProperty("definitions.node.properties.label.type", ["string", "null"]);
  });

  it("uses the inline path for root, scoped, nullable, and unresolved references", () => {
    const schemas: unknown[] = [
      { $ref: "#/$defs/input", $defs: { input: detail } },
      { anyOf: [{ $ref: "#/$defs/input" }], $defs: { input: detail } },
    ];
    for (const nested of [
      { $id: "https://example.invalid/schema", properties: {} },
      { $defs: { local: { type: "string" } }, properties: { label: { $ref: "#/$defs/local" } } },
      { properties: { label: { $ref: "#/$defs/missing" } } },
      { properties: { label: { $ref: "#/$defs/input", nullable: true } } },
    ]) {
      schemas.push({
        ...batch,
        properties: { ...batch.properties, extra: { type: "object", ...nested } },
      });
    }
    for (const schema of schemas) {
      expect(normalize(schema, openai)).toEqual(normalize(schema));
    }
  });
});

describe("root unions with preset and custom strings", () => {
  const presetNames = Type.Union([Type.Literal("compact"), Type.Literal("wide")]);
  const presets = Type.Object({ action: Type.Literal("preset"), value: presetNames });
  const custom = Type.Object({ action: Type.Literal("custom"), value: Type.String() });
  const union = (branches: TSchema[], keyword = "anyOf") => ({
    type: "object",
    [keyword]: Type.Union(branches).anyOf,
  });
  const values = (...alternatives: TSchema[]) =>
    Type.Union(alternatives.map((value) => Type.Object({ value })));
  function check(
    schema: TSchema | Record<string, unknown>,
    accepted: unknown[],
    rejected: unknown[] = [],
    modelProvider?: string,
  ) {
    const normalized = normalize(schema, { modelProvider });
    const validator = Compile(normalized);
    for (const input of accepted) {
      expect(Compile(schema).Check(input)).toBe(true);
      expect(validator.Check(input)).toBe(true);
    }
    for (const input of rejected) {
      expect(validator.Check(input)).toBe(false);
    }
    return normalized;
  }
  it.each([
    ["anyOf", "openai"],
    ["oneOf", "openai"],
    ["anyOf", "google"],
    ["oneOf", "google"],
  ])("keeps custom strings for %s with %s", (keyword, provider) => {
    for (const branches of [
      [presets, custom],
      [custom, presets],
    ]) {
      const schema = union(branches, keyword);
      const original = structuredClone(schema);
      check(
        schema,
        [
          { action: "preset", value: "compact" },
          { action: "preset", value: "wide" },
          { action: "custom", value: "customer-layout" },
        ],
        [
          { action: "unknown", value: "compact" },
          { action: "custom", value: 42 },
        ],
        provider,
      );
      expect(schema).toEqual(original);
    }
  });
  it("preserves root-union constraints, alternative types, and annotations", () => {
    check(
      { ...union([presets, custom]), properties: { value: presetNames } },
      [{ action: "custom", value: "compact" }],
      [{ action: "custom", value: "customer-layout" }],
    );
    for (const value of [
      Type.String({ pattern: "^custom-" }),
      Type.String({ minLength: 20 }),
      Type.Number(),
    ]) {
      const constrained = Type.Object({ action: Type.Literal("custom"), value });
      for (const branches of [
        [presets, constrained],
        [constrained, presets],
      ]) {
        check(union(branches), [{ action: "preset", value: "compact" }], [], "google");
      }
    }
    const annotated = check(
      values(
        Type.Literal("compact", { description: "Layout name" }),
        Type.String({ description: "Custom name", default: "custom", examples: ["custom"] }),
        Type.Literal("wide"),
      ),
      [{ value: "customer-layout" }],
    );
    expect(annotated).toHaveProperty("properties.value", {
      type: "string",
      description: "Layout name",
      default: "custom",
      examples: ["custom"],
    });
    check(values(Type.Literal(42), Type.String()), [{ value: 42 }]);
    check(values(Type.Literal("compact"), Type.String(), Type.Literal(42)), [
      { value: "compact" },
      { value: 42 },
    ]);
    check(
      values(presetNames, Type.Union([Type.Literal("custom"), Type.Literal("compact")])),
      ["compact", "wide", "custom"].map((value) => ({ value })),
      [{ value: "unknown" }],
    );
  });
});
