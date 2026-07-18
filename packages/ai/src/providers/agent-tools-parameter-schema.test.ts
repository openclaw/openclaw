// Tests for schema normalization, including GBNF-safe maxLength caps.
import { describe, expect, it } from "vitest";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import type { ToolSchemaModelCompat } from "./agent-tools-parameter-schema.js";

type SchemaLike = Record<string, unknown> & {
  type?: string;
  maxLength?: number;
  minLength?: number;
  properties?: Record<string, SchemaLike>;
  items?: SchemaLike;
  anyOf?: SchemaLike[];
  oneOf?: SchemaLike[];
};

const GBNF_SAFE_CEILING = 2000;
const LLAMA_CPP_COMPAT: ToolSchemaModelCompat = { capGbnfMaxLength: true };

function collectStringFields(
  label: string,
  schema: SchemaLike | undefined,
): Array<{ path: string; maxLength?: number }> {
  const results: Array<{ path: string; maxLength?: number }> = [];
  if (!schema) {
    return results;
  }
  if (schema.type === "string") {
    results.push({ path: label, maxLength: schema.maxLength });
  }
  if (schema.properties) {
    for (const [key, val] of Object.entries(schema.properties)) {
      results.push(...collectStringFields(`${label}.${key}`, val));
    }
  }
  if (schema.items) {
    results.push(...collectStringFields(`${label}[]`, schema.items));
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((alt, i) =>
      results.push(...collectStringFields(`${label}[anyOf:${i}]`, alt)),
    );
  }
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((alt, i) =>
      results.push(...collectStringFields(`${label}[oneOf:${i}]`, alt)),
    );
  }
  return results;
}

function fieldMaxLength(
  fields: Array<{ path: string; maxLength?: number }>,
  path: string,
): number | undefined {
  const field = fields.find((f) => f.path === path);
  return field?.maxLength;
}

function requireField(
  fields: Array<{ path: string; maxLength?: number }>,
  path: string,
): number | undefined {
  const field = fields.find((f) => f.path === path);
  expect(field, `Expected field ${path} to exist`).toBeDefined();
  return field?.maxLength;
}

describe("normalizeToolParameterSchema GBNF cap", () => {
  describe("with capGbnfMaxLength enabled", () => {
    it("caps string maxLength exceeding GBNF-safe ceiling", () => {
      const schema = normalizeToolParameterSchema(
        {
          type: "object",
          properties: {
            script: { type: "string", minLength: 1, maxLength: 65_536 },
          },
          required: ["script"],
        },
        { modelCompat: LLAMA_CPP_COMPAT },
      );
      const fields = collectStringFields("root", schema as SchemaLike);
      expect(requireField(fields, "root.script")).toBe(GBNF_SAFE_CEILING);
    });

    it("leaves maxLength untouched when already at or under ceiling", () => {
      const schema = normalizeToolParameterSchema(
        {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 200 },
            note: { type: "string", maxLength: 1000 },
          },
        },
        { modelCompat: LLAMA_CPP_COMPAT },
      );
      const fields = collectStringFields("root", schema as SchemaLike);
      expect(fieldMaxLength(fields, "root.name")).toBe(200);
      expect(fieldMaxLength(fields, "root.note")).toBe(1000);
    });

    it("caps nested string fields in array items", () => {
      const schema = normalizeToolParameterSchema(
        {
          type: "object",
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  body: { type: "string", maxLength: 100_000 },
                },
              },
            },
          },
        },
        { modelCompat: LLAMA_CPP_COMPAT },
      );
      const fields = collectStringFields("root", schema as SchemaLike);
      expect(requireField(fields, "root.entries[].body")).toBe(GBNF_SAFE_CEILING);
    });

    it("caps string fields inside anyOf variants", () => {
      const schema = normalizeToolParameterSchema(
        {
          type: "object",
          properties: {
            trigger: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    script: { type: "string", minLength: 1, maxLength: 65_536 },
                  },
                  required: ["script"],
                },
                { type: "null" },
              ],
            },
          },
        },
        { modelCompat: LLAMA_CPP_COMPAT },
      );
      const fields = collectStringFields("root", schema as SchemaLike);
      const scriptField = fields.find((f) => f.path.includes(".script"));
      expect(scriptField).toBeDefined();
      expect(scriptField?.maxLength).toBe(GBNF_SAFE_CEILING);
    });
  });

  describe("without capGbnfMaxLength (default)", () => {
    it("keeps original maxLength when cap is not enabled", () => {
      const schema = normalizeToolParameterSchema({
        type: "object",
        properties: {
          script: { type: "string", minLength: 1, maxLength: 65_536 },
        },
        required: ["script"],
      });
      const fields = collectStringFields("root", schema as SchemaLike);
      expect(requireField(fields, "root.script")).toBe(65_536);
    });

    it("keeps nested large maxLength in array items unchanged", () => {
      const schema = normalizeToolParameterSchema({
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string", maxLength: 100_000 },
              },
            },
          },
        },
      });
      const fields = collectStringFields("root", schema as SchemaLike);
      expect(requireField(fields, "root.entries[].body")).toBe(100_000);
    });

    it("keeps large maxLength inside anyOf variants unchanged", () => {
      const schema = normalizeToolParameterSchema({
        type: "object",
        properties: {
          trigger: {
            anyOf: [
              {
                type: "object",
                properties: {
                  script: { type: "string", minLength: 1, maxLength: 65_536 },
                },
                required: ["script"],
              },
              { type: "null" },
            ],
          },
        },
      });
      const fields = collectStringFields("root", schema as SchemaLike);
      const scriptField = fields.find((f) => f.path.includes(".script"));
      expect(scriptField).toBeDefined();
      expect(scriptField?.maxLength).toBe(65_536);
    });
  });

  it("handles empty schemas without error", () => {
    expect(() => normalizeToolParameterSchema({})).not.toThrow();
    expect(() => normalizeToolParameterSchema(null)).not.toThrow();
    expect(() => normalizeToolParameterSchema(undefined)).not.toThrow();
  });

  it("leaves strings without maxLength unchanged", () => {
    const schema = normalizeToolParameterSchema(
      {
        type: "object",
        properties: {
          openText: { type: "string", minLength: 1 },
        },
      },
      { modelCompat: LLAMA_CPP_COMPAT },
    );
    const fields = collectStringFields("root", schema as SchemaLike);
    expect(requireField(fields, "root.openText")).toBeUndefined();
  });
});
