import { validateToolCall } from "@openclaw/llm-core/validation";
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { expect, it } from "vitest";
import { normalizeToolParameterSchema as normalize } from "./agent-tools-parameter-schema.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import { projectRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

const openai = { modelProvider: "openai" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
const required = (properties: Record<string, unknown>) => ({
  ...object(properties),
  required: Object.keys(properties),
});
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
function closed(properties: Record<string, unknown>, requiredKeys = Object.keys(properties)) {
  return { ...object(properties), required: requiredKeys, additionalProperties: false };
}
function inlined(schema: unknown) {
  const normalized = normalize(schema, openai);
  expect(JSON.stringify(normalized)).not.toContain('"$ref"');
  return normalized;
}
const fields = Object.fromEntries(
  Array.from({ length: 50 }, (_, index) => [`field_${index}`, { type: "string" }]),
);
const detail = closed(fields, ["field_0"]);
const variants = ["page", "claim", "relationship"].map((kind) =>
  closed({ kind: { const: kind }, input: reference("input") }),
);
const batch = {
  ...closed({ items: { type: "array", items: { anyOf: variants } } }),
  $defs: { input: detail },
};

it.each(["$defs", "definitions"])("coerces tool calls without expanding %s", (table) => {
  const ref = (name: string) => ({ $ref: `#/${table}/${name}` });
  const settings = required({ enabled: { type: "boolean" }, count: { type: "integer" } });
  const schema = {
    ...required({ tags: ref("tags"), records: ref("records"), settings: ref("settings") }),
    [table]: {
      tags: { type: "array", items: { type: "string" } },
      records: { type: "array", items: ref("settings") },
      settings,
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
  expect({ args, parameters }).toEqual({ args: input, parameters: before });
  expect(parameters).toHaveProperty([table, "settings"]);
  expect(parameters).toHaveProperty("properties.tags.$ref", `#/${table}/tags`);
});

it.each(["root id", "nested defs"])("coerces through %s fallback", (shape) => {
  const settings = {
    ...required({ count: { type: "integer" } }),
    ...(shape === "nested defs" ? { $defs: { unused: { type: "string" } } } : {}),
  };
  const parameters = inlined({
    ...defined("settings", { settings }),
    ...(shape === "root id" ? { $id: "https://example.invalid/tool" } : {}),
  });
  expect(validate(parameters, { settings: '{"count":"2"}' })).toEqual({
    settings: { count: 2 },
  });
});

it("inlines malformed and encoded references and removes unused definitions", () => {
  const value = object({ limit: { type: "number" } });
  const stringValue = object({ value: { type: "string" } });
  for (const table of ["$defs", "definitions"]) {
    expect(normalize(defined("value", [{ type: "string" }], table, "0"), openai)).toEqual(
      stringValue,
    );
  }
  const unused = {
    unused: object({ next: reference("large") }),
    large: { ...detail, description: "Unused definition".repeat(400) },
  };
  expect(inlined({ ...structuredClone(stringValue), $defs: unused })).toEqual(stringValue);
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
        ...required({ filter: { $ref: ref } }),
        definitions: { "Partial<Filter>": value },
      };
      expect(normalize(schema, options)).toEqual(required({ filter: value }));
    }
  }
});

it.each([false, true])("retains Responses payload inlining with strict=%s", (strict) => {
  const schema = {
    ...closed({ value: { ...reference("value"), description: "Value" } }),
    $defs: { value: { type: "string", maxLength: 10 } },
  };
  const normalized = normalize(schema, openai);
  expect(normalized).toHaveProperty("properties.value.$ref", "#/$defs/value");
  const tools = [{ name: "ref", description: "", parameters: normalized }];
  const [tool] = convertResponsesToolPayload(tools, { strict });
  expect(tool).toMatchObject({
    strict,
    parameters: object({ value: { type: "string", maxLength: 10, description: "Value" } }),
  });
  expect(JSON.stringify(tool)).not.toContain('"$ref"');
  expect(tool?.parameters).not.toHaveProperty("$defs");
});

it("keeps batch types through shared normalization and Codex projection", () => {
  // Inlining crosses Codex's 5,000-byte limit and erases item types.
  expect(JSON.stringify(normalize(batch)).length).toBeGreaterThan(5000);
  const normalized = normalize(batch, openai);
  const projected = projectRuntimeToolInputSchema(normalizeOpenAIStrictCompatSchema(normalized));
  expect(projected).toMatchObject({ violations: [], schema: batch });
  expect(JSON.stringify(projected.schema).length).toBeLessThan(5000);
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
  const normalized = inlined({
    ...batch,
    properties: { ...batch.properties, extra: { $ref: "#/components/schemas/Extra" } },
    components: { schemas: { Extra: { type: "string" } } },
  });
  expect(normalized).not.toHaveProperty("components");
  expect(normalized).toHaveProperty("properties.extra.type", "string");
});

it("preserves ref siblings, legacy definitions, and recursive refs", () => {
  const node = object({
    next: reference("node", "definitions"),
    label: { type: "string", nullable: true },
  });
  const root = { ...reference("node", "definitions"), description: "Root", maxProperties: 2 };
  const schema = { ...object({ node: root }), definitions: { node } };
  const normalized = normalize(schema, openai);
  expect(normalized).toHaveProperty("properties.node", root);
  expect(normalized).toHaveProperty(
    "definitions.node.properties.next",
    reference("node", "definitions"),
  );
  expect(normalized).toHaveProperty("definitions.node.properties.label.type", ["string", "null"]);
});

it("uses the inline path for root, scoped, nullable, and unresolved references", () => {
  const nested = [
    { $id: "https://example.invalid/schema", properties: {} },
    { $defs: { local: { type: "string" } }, properties: { label: { $ref: "#/$defs/local" } } },
    { properties: { label: { $ref: "#/$defs/missing" } } },
    { properties: { label: { $ref: "#/$defs/input", nullable: true } } },
  ].map((extra) =>
    Object.assign({}, batch, {
      properties: { ...batch.properties, extra: { type: "object", ...extra } },
    }),
  );
  for (const schema of [
    { $ref: "#/$defs/input", $defs: { input: detail } },
    { anyOf: [{ $ref: "#/$defs/input" }], $defs: { input: detail } },
    ...nested,
  ]) {
    expect(normalize(schema, openai)).toEqual(normalize(schema));
  }
});

const presetNames = Type.Union([Type.Literal("compact"), Type.Literal("wide")]);
const presets = Type.Object({ action: Type.Literal("preset"), value: presetNames });
const custom = Type.Object({ action: Type.Literal("custom"), value: Type.String() });
const presetInput = (value: string) => ({ action: "preset", value });
const customInput = (value: unknown) => ({ action: "custom", value });
const orders = (first: TSchema, second: TSchema) => [
  [first, second],
  [second, first],
];
const union = (branches: TSchema[], keyword = "anyOf") => ({
  type: "object",
  [keyword]: Type.Union(branches).anyOf,
});
const values = (...alternatives: TSchema[]) =>
  Type.Union(alternatives.map((value) => Type.Object({ value })));
function check(schema: TSchema, accepted: unknown[], rejected: unknown[] = [], provider?: string) {
  const normalized = normalize(schema, { modelProvider: provider });
  const validator = Compile(normalized);
  accepted.forEach((input) => expect(validator.Check(input)).toBe(true));
  rejected.forEach((input) => expect(validator.Check(input)).toBe(false));
  return normalized;
}
it.each([
  ["anyOf", "openai"],
  ["oneOf", "openai"],
  ["anyOf", "google"],
  ["oneOf", "google"],
])("keeps custom strings for %s with %s", (keyword, provider) => {
  for (const branches of orders(presets, custom)) {
    const schema = union(branches, keyword);
    const original = structuredClone(schema);
    check(
      schema,
      [presetInput("compact"), presetInput("wide"), customInput("customer-layout")],
      [{ action: "unknown", value: "compact" }, customInput(42)],
      provider,
    );
    expect(schema).toEqual(original);
  }
});
it("preserves root-union constraints, alternative types, and annotations", () => {
  check(
    { ...union([presets, custom]), properties: { value: presetNames } },
    [customInput("compact")],
    [customInput("customer-layout")],
  );
  for (const value of [
    Type.String({ pattern: "^custom-" }),
    Type.String({ minLength: 20 }),
    Type.Number(),
  ]) {
    const constrained = Type.Object({ action: Type.Literal("custom"), value });
    for (const branches of orders(presets, constrained)) {
      check(union(branches), [presetInput("compact")], [], "google");
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
