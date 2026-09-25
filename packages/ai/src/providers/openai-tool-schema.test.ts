// Verifies OpenAI strict tool schema normalization and cache behavior.
import { deepStrictEqual } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import { cleanSchemaForLlamacppGbnf } from "./clean-for-llamacpp-gbnf.js";
import { projectOpenAITools } from "./openai-tool-projection.js";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import {
  findOpenAIStrictSchemaViolations,
  findOpenAIStrictToolProjectionDiagnostics,
  isStrictOpenAIJsonSchemaCompatible,
  normalizeOpenAIStrictToolParameters,
  normalizeStrictOpenAIJsonSchema,
  resolveOpenAIProjectedToolsStrictToolFlag,
} from "./openai-tool-schema.js";

describe("OpenAI strict tool schema normalization", () => {
  it.each([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
  ])("preserves literal names when repairing the %s schema map", (mapKey) => {
    const schema = {
      type: "object",
      [mapKey]: { ["__proto__"]: { type: "string", description: null } },
    };

    const normalized = normalizeOpenAIStrictCompatSchema(schema);
    expect(Object.getOwnPropertyDescriptor(normalized, mapKey)?.value).toStrictEqual({
      ["__proto__"]: { type: "string" },
    });
    expect(schema[mapKey]).toStrictEqual({
      ["__proto__"]: { type: "string", description: null },
    });
  });

  it("infers the root type from schema fields instead of a literal prototype key", () => {
    const schema = {
      ["__proto__"]: { type: "array" },
      properties: { path: { type: "string" } },
      description: null,
    };

    expect(normalizeOpenAIStrictCompatSchema(schema)).toStrictEqual({
      ["__proto__"]: { type: "array" },
      properties: { path: { type: "string" } },
      type: "object",
    });
  });

  it("preserves literal property names when strict normalization repairs a nested object", () => {
    const schema = {
      type: "object",
      properties: { ["__proto__"]: { type: "object", properties: {} } },
      required: ["__proto__"],
      additionalProperties: false,
    };

    expect(normalizeStrictOpenAIJsonSchema(schema)).toStrictEqual({
      ...schema,
      properties: { ["__proto__"]: { type: "object", properties: {}, required: [] } },
    });
  });

  it.each(["anyOf", "oneOf"])(
    "preserves variant-only literal properties when flattening %s",
    (unionKey) => {
      const properties = {
        ["__proto__"]: { type: "string", minLength: 1 },
        constructor: { type: "integer" },
        toString: { type: "boolean" },
      };
      const required = ["__proto__", "constructor", "toString"];
      const schema = {
        [unionKey]: [
          { type: "object", properties, required },
          { type: "object", properties: { ["__proto__"]: { type: "string" } }, required },
        ],
        additionalProperties: false,
      };

      deepStrictEqual(normalizeStrictOpenAIJsonSchema(schema), {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      });
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    },
  );

  it("preserves literal metadata when removing OpenAPI annotations", () => {
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
      ["__proto__"]: { type: "array" },
    };

    expect(normalizeStrictOpenAIJsonSchema({ ...schema, nullable: false })).toStrictEqual(schema);
  });

  it("repairs top-level object schemas with missing or invalid properties", () => {
    const schemas = [
      { type: "object" },
      { type: "object", properties: undefined },
      { type: "object", properties: null },
      { type: "object", properties: [] },
      { type: "object", properties: "invalid" },
    ];

    for (const schema of schemas) {
      expect(normalizeStrictOpenAIJsonSchema(schema)).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    }
  });

  it("does not close permissive nested object schemas implicitly", () => {
    // Nested permissive objects stay incompatible unless callers make them strict.
    const schema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
        },
      },
      required: ["metadata"],
    };

    const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
      additionalProperties?: boolean;
      properties?: { metadata?: { additionalProperties?: boolean } };
    };

    expect(normalized.additionalProperties).toBe(false);
    expect(normalized.properties?.metadata).not.toHaveProperty("additionalProperties");
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    expect(
      resolveOpenAIProjectedToolsStrictToolFlag(
        projectOpenAITools([{ name: "write", parameters: schema }]),
        true,
      ),
    ).toBe(false);
  });

  it("walks named schema maps without treating definition names as keywords", () => {
    const schema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      $defs: {
        anyOf: { type: "string" },
      },
      examples: [{ anyOf: [{ type: "string" }] }],
    };

    expect(
      findOpenAIStrictSchemaViolations(schema, "parameters", { requireObjectRoot: true }),
    ).toEqual([]);
  });

  it("walks legacy and content schema applicators", () => {
    const nestedObject = {
      type: "object",
      properties: { value: { type: "string" } },
    };
    const schema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      dependencies: {
        mode: ["payload"],
        payload: nestedObject,
      },
      additionalItems: nestedObject,
      contentSchema: nestedObject,
    };

    expect(
      findOpenAIStrictSchemaViolations(schema, "parameters", { requireObjectRoot: true }),
    ).toEqual([
      "parameters.dependencies.payload.additionalProperties",
      "parameters.dependencies.payload.required",
      "parameters.additionalItems.additionalProperties",
      "parameters.additionalItems.required",
      "parameters.contentSchema.additionalProperties",
      "parameters.contentSchema.required",
    ]);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
  });

  it("normalizes truly empty MCP tool schema {} for strict mode", () => {
    const schema = {};
    const normalized = normalizeStrictOpenAIJsonSchema(schema) as Record<string, unknown>;
    expect(normalized.type).toBe("object");
    expect(normalized.properties).toStrictEqual({});
    expect(normalized.required).toStrictEqual([]);
    expect(normalized.additionalProperties).toBe(false);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
  });

  it("reuses normalized strict schemas for stable tool schema objects", () => {
    // Cache keys include unsupported-keyword policy, not just object identity.
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    };

    const first = normalizeStrictOpenAIJsonSchema(schema);
    const second = normalizeStrictOpenAIJsonSchema(schema);
    const third = normalizeStrictOpenAIJsonSchema(schema, {
      unsupportedToolSchemaKeywords: ["minimum"],
    });

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(
      normalizeStrictOpenAIJsonSchema(schema, {
        unsupportedToolSchemaKeywords: ["minimum"],
      }),
    ).toBe(third);
  });

  it("reports unreadable nested tool schemas instead of throwing", () => {
    const unreadable = {
      name: "broken",
      parameters: {
        type: "object",
        get properties(): never {
          throw new Error("properties exploded");
        },
      },
    };

    const projection = projectOpenAITools([unreadable]);

    expect(findOpenAIStrictToolProjectionDiagnostics(projection)).toEqual([
      {
        toolIndex: 0,
        toolName: "broken",
        violations: ["broken.parameters is not JSON-serializable"],
      },
    ]);
  });

  it("keeps strict mode for emitted tools when unreadable tools are dropped", () => {
    const projection = projectOpenAITools([
      {
        name: "broken",
        parameters: {
          type: "object",
          get properties(): never {
            throw new Error("properties exploded");
          },
        },
      },
      {
        name: "lookup",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);

    expect(resolveOpenAIProjectedToolsStrictToolFlag(projection, true)).toBe(true);
  });

  it("reuses projected schemas for strict checks and normalization", () => {
    let serializationCount = 0;
    const projection = projectOpenAITools([
      {
        name: "lookup",
        parameters: {
          toJSON() {
            serializationCount += 1;
            return {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            };
          },
        },
      },
    ]);
    const tool = projection.tools[0];
    expect(tool).toBeDefined();

    expect(resolveOpenAIProjectedToolsStrictToolFlag(projection, true)).toBe(true);
    const normalized = normalizeOpenAIStrictToolParameters(tool?.parameters, true);
    expect(normalizeOpenAIStrictToolParameters(tool?.parameters, true)).toBe(normalized);
    expect(serializationCount).toBe(1);
  });
});

describe("deeply nested tool schemas", () => {
  // A depth that overflows the previous recursive walkers with RangeError: Maximum call
  // stack size exceeded on default Node stack sizes (#141306). The walkers are iterative now,
  // so the same input must normalize successfully.
  const DEEP_LEVELS = 20_000;

  function buildDeepObjectChain(levels: number): Record<string, unknown> {
    let current: Record<string, unknown> = { type: "string", title: "leaf" };
    for (let i = 0; i < levels; i += 1) {
      current = { type: "object", properties: { child: current }, required: ["child"] };
    }
    return current;
  }

  function readDeepLeaf(schema: unknown, levels: number): Record<string, unknown> | undefined {
    let current = schema as Record<string, unknown> | undefined;
    for (let i = 0; i < levels; i += 1) {
      const properties = current?.properties as Record<string, unknown> | undefined;
      current = properties?.child as Record<string, unknown> | undefined;
    }
    return current;
  }

  it("normalizes deep nesting on the default provider path", () => {
    const schema = buildDeepObjectChain(DEEP_LEVELS);
    const normalized = normalizeToolParameterSchema(schema);
    expect(readDeepLeaf(normalized, DEEP_LEVELS)?.title).toBe("leaf");
  });

  it("normalizes deep nesting in OpenAI strict mode", () => {
    const schema = buildDeepObjectChain(DEEP_LEVELS);
    const normalized = normalizeOpenAIStrictToolParameters(schema, true, null) as Record<
      string,
      unknown
    >;
    expect(normalized.additionalProperties).toBe(false);
    expect(readDeepLeaf(normalized, DEEP_LEVELS)?.title).toBe("leaf");
  });

  it("normalizes deep nesting with omitEmptyArrayItems", () => {
    const schema = buildDeepObjectChain(DEEP_LEVELS);
    const normalized = normalizeToolParameterSchema(schema, {
      modelCompat: { omitEmptyArrayItems: true },
    });
    expect(readDeepLeaf(normalized, DEEP_LEVELS)?.title).toBe("leaf");
  });

  it("normalizes deep nesting on the Gemini provider path", () => {
    const schema = buildDeepObjectChain(DEEP_LEVELS);
    const normalized = normalizeToolParameterSchema(schema, {
      modelProvider: "google",
      modelId: "gemini-2.5-pro",
    });
    expect(readDeepLeaf(normalized, DEEP_LEVELS)?.title).toBe("leaf");
  });

  it("normalizes deep nesting on the llamacpp GBNF profile", () => {
    const schema = buildDeepObjectChain(DEEP_LEVELS);
    const normalized = normalizeToolParameterSchema(schema, {
      modelCompat: { toolSchemaProfile: "llamacpp" },
    });
    expect(readDeepLeaf(normalized, DEEP_LEVELS)?.title).toBe("leaf");
  });

  it("normalizes deep nesting while stripping unsupported keywords", () => {
    const schema = buildDeepObjectChain(DEEP_LEVELS);
    const normalized = normalizeToolParameterSchema(schema, {
      modelCompat: { unsupportedToolSchemaKeywords: ["pattern", "minLength"] },
    });
    expect(readDeepLeaf(normalized, DEEP_LEVELS)?.title).toBe("leaf");
  });

  it("checks deep schemas for strict compatibility and violations", () => {
    const schema = buildDeepObjectChain(DEEP_LEVELS);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    const violations = findOpenAIStrictSchemaViolations(schema, "root");
    expect(violations).toContain("root.additionalProperties");
  });

  it("repairs deep schemas in the OpenAI strict compat pass", () => {
    const schema = buildDeepObjectChain(DEEP_LEVELS);
    const normalized = normalizeOpenAIStrictCompatSchema(schema);
    expect(readDeepLeaf(normalized, DEEP_LEVELS)?.title).toBe("leaf");
  });

  it("inlines a deep flat $defs chain", () => {
    const links = 3_000;
    const defs: Record<string, unknown> = {};
    for (let i = links - 1; i >= 0; i -= 1) {
      defs[`d${i}`] =
        i === links - 1
          ? { type: "object", properties: { leaf: { type: "string" } } }
          : { $ref: `#/$defs/d${i + 1}` };
    }
    const schema = { $ref: "#/$defs/d0", $defs: defs, title: "chain" };
    const normalized = normalizeToolParameterSchema(schema) as Record<string, unknown>;
    expect(normalized.title).toBe("chain");
    expect(normalized.$defs).toBeUndefined();
    expect((normalized.properties as Record<string, unknown> | undefined)?.leaf).toStrictEqual({
      type: "string",
    });
  });

  it("rejects circular object graphs with a typed error instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} };
    (cyclic.properties as Record<string, unknown>).self = cyclic;
    expect(() => normalizeToolParameterSchema(cyclic)).toThrow(TypeError);
    expect(() => normalizeToolParameterSchema(cyclic)).toThrow(/circular/i);
  });
});

describe("schema walker compatibility regressions", () => {
  it("preserves an own __proto__ property when llamacpp cleaning changes the child", () => {
    const schema = {
      type: "object",
      properties: { ["__proto__"]: { type: "string", pattern: "x" } },
      required: ["__proto__"],
    };

    const cleaned = cleanSchemaForLlamacppGbnf(schema) as Record<string, unknown>;
    const properties = cleaned.properties as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(properties, "__proto__")?.value).toStrictEqual({
      type: "string",
    });
    expect(cleaned.required).toStrictEqual(["__proto__"]);
  });

  it("collects wide composed enums without hitting the argument-spread limit", () => {
    const wideEnum = Array.from({ length: 1_000_000 }, (_, index) => `v${index}`);
    const schema = {
      anyOf: [
        { type: "object", properties: { pick: { anyOf: [{ enum: wideEnum }] } } },
        { type: "object", properties: { pick: { anyOf: [{ enum: ["v0"] }] } } },
      ],
    };

    const normalized = normalizeToolParameterSchema(schema) as Record<string, unknown>;
    const properties = normalized.properties as Record<string, unknown>;
    const pick = properties.pick as Record<string, unknown>;
    expect(Array.isArray(pick.enum)).toBe(true);
    expect((pick.enum as unknown[]).length).toBe(1_000_000);
  });
});
