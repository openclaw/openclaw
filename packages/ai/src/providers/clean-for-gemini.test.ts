// Gemini schema cleaner tests cover OpenAPI-compatible tool schema cleanup for
// Gemini-backed providers before schemas are sent upstream.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

const execFileAsync = promisify(execFile);

describe("cleanSchemaForGemini", () => {
  it("normalizes deep nullable schemas in a cold process", async () => {
    const source = String.raw`
      import assert from "node:assert/strict";
      import { cleanSchemaForGemini } from ${JSON.stringify(new URL("./clean-for-gemini.ts", import.meta.url).href)};
      import { stripUnsupportedSchemaKeywords } from ${JSON.stringify(new URL("./schema-keyword-strip.ts", import.meta.url).href)};
      let value = { type: "string", format: "date-time" };
      for (let index = 0; index < 2048; index += 1) {
        value = { anyOf: [value, { type: "null" }] };
      }
      const schema = JSON.parse(JSON.stringify({
        type: "object", properties: { value }, required: ["value"],
      }));
      const normalized = cleanSchemaForGemini(schema);
      const stripped = stripUnsupportedSchemaKeywords(schema, new Set(["format"]));
      let leaf = stripped.properties.value;
      for (let index = 0; index < 2048; index += 1) {
        assert.equal(leaf.anyOf.length, 2);
        assert.deepEqual(leaf.anyOf[1], { type: "null" });
        leaf = leaf.anyOf[0];
      }
      const circular = { type: "object", properties: {} };
      circular.properties.self = circular;
      assert.throws(() => cleanSchemaForGemini(circular), TypeError);
      assert.throws(() => stripUnsupportedSchemaKeywords(circular, new Set()), TypeError);
      process.stdout.write(JSON.stringify({ normalized, leaf }));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=192", "--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 20_000 },
    );
    expect(JSON.parse(stdout)).toEqual({
      normalized: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      leaf: { type: "string" },
    });
  }, 30_000);

  it("strips serialized optional markers without changing required fields or the input", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string" },
        timeout: { type: "number", "~optional": true },
        options: {
          type: "array",
          "~optional": true,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              label: { type: "string", "~optional": true },
            },
            required: ["name"],
          },
        },
      },
      required: ["action"],
    };
    const original = structuredClone(schema);

    expect(cleanSchemaForGemini(schema)).toStrictEqual({
      type: "object",
      properties: {
        action: { type: "string" },
        timeout: { type: "number" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, label: { type: "string" } },
            required: ["name"],
          },
        },
      },
      required: ["action"],
    });
    expect(schema).toStrictEqual(original);
  });

  it("preserves literal property names and defaults matching the optional marker", () => {
    const schema = {
      type: "object",
      properties: { "~optional": { type: "string", "~optional": true } },
      default: { "~optional": "literal value" },
    };

    expect(cleanSchemaForGemini(schema)).toStrictEqual({
      type: "object",
      properties: { "~optional": { type: "string" } },
      default: { "~optional": "literal value" },
    });
  });

  it("coerces null properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: null,
    }) as { type?: unknown; properties?: unknown };

    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toStrictEqual({});
  });

  it("coerces non-object properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: "invalid",
    }) as { properties?: unknown };

    expect(cleaned.properties).toStrictEqual({});
  });

  it("coerces array properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: [],
    }) as { properties?: unknown };

    expect(cleaned.properties).toStrictEqual({});
  });

  it("filters required fields that are not in properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        action: { type: "string" },
        amount: { type: "number" },
      },
      required: ["action", "amount", "token"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["action", "amount"]);
  });

  it("preserves required when all fields exist in properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        action: { type: "string" },
        amount: { type: "number" },
      },
      required: ["action", "amount"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["action", "amount"]);
  });

  it("removes required entirely when no fields match properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        action: { type: "string" },
      },
      required: ["missing_a", "missing_b"],
    }) as { required?: string[] };

    expect(cleaned.required).toBeUndefined();
  });

  it("removes required from object schemas when properties is absent", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      required: ["a", "b"],
    }) as { required?: string[] };

    expect(cleaned.required).toBeUndefined();
  });

  it("leaves required as-is for non-object schemas when properties is absent", () => {
    const cleaned = cleanSchemaForGemini({
      type: "array",
      required: ["a", "b"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["a", "b"]);
  });

  it("filters required in nested object properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name", "ghost"],
        },
      },
    }) as { properties?: { config?: { required?: string[] } } };

    expect(cleaned.properties?.config?.required).toEqual(["name"]);
  });

  it("does not treat inherited keys as declared properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["toString", "name"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["name"]);
  });

  it("coerces nested null properties while preserving valid siblings", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        bad: {
          type: "object",
          properties: null,
        },
        good: {
          type: "string",
        },
      },
    }) as {
      properties?: {
        bad?: { properties?: unknown };
        good?: { type?: unknown };
      };
    };

    expect(cleaned.properties?.bad?.properties).toStrictEqual({});
    expect(cleaned.properties?.good?.type).toBe("string");
  });

  it("strips empty required arrays", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: [],
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty("required");
    expect(cleaned.type).toBe("object");
  });

  it("preserves non-empty required arrays", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    }) as Record<string, unknown>;

    expect(cleaned.required).toEqual(["name"]);
  });

  it("strips empty required arrays in nested schemas", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            optional: { type: "string" },
          },
          required: [],
        },
      },
      required: ["nested"],
    }) as { properties?: { nested?: Record<string, unknown> }; required?: string[] };

    expect(cleaned.required).toEqual(["nested"]);
    expect(cleaned.properties?.nested).not.toHaveProperty("required");
  });

  it("strips the not keyword from schemas", () => {
    // `not` is outside the OpenAPI 3.0 subset accepted by Gemini-backed
    // providers and triggers upstream HTTP 400s if left in tool schemas.
    const cleaned = cleanSchemaForGemini({
      type: "object",
      not: { const: true },
      properties: {
        name: { type: "string" },
      },
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty("not");
    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toEqual({ name: { type: "string" } });
  });

  it("collapses type arrays by stripping null entries", () => {
    // Type arrays like ["string", "null"] must collapse to a scalar OpenAPI
    // type for Gemini compatibility.
    const cleaned = cleanSchemaForGemini({
      type: ["string", "null"],
      description: "nullable field",
    }) as Record<string, unknown>;

    expect(cleaned.type).toBe("string");
    expect(cleaned.description).toBe("nullable field");
  });

  it("collapses type arrays in nested property schemas", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        agentId: {
          type: ["string", "null"],
          description: "Agent id",
        },
      },
    }) as { properties?: { agentId?: Record<string, unknown> } };

    expect(cleaned.properties?.agentId?.type).toBe("string");
  });

  it.each([
    {
      name: "integer enum",
      schema: { type: "integer", enum: [1, 2, 3] },
      expected: { type: "integer", enum: ["1", "2", "3"] },
    },
    {
      name: "integer enum before type",
      schema: { enum: [1, 2, 3], type: "integer" },
      expected: { enum: ["1", "2", "3"], type: "integer" },
    },
    {
      name: "boolean enum",
      schema: { type: "boolean", enum: [true, false] },
      expected: { type: "boolean", enum: ["true", "false"] },
    },
    {
      name: "string enum",
      schema: { type: "string", enum: ["a", "b", "c"] },
      expected: { type: "string", enum: ["a", "b", "c"] },
    },
    {
      name: "integer const before type",
      schema: { const: 42, type: "integer" },
      expected: { enum: ["42"], type: "integer" },
    },
  ])("stringifies $name values without changing the schema type", ({ schema, expected }) => {
    expect(cleanSchemaForGemini(schema)).toStrictEqual(expected);
  });

  it("drops null/undefined enum entries and de-duplicates", () => {
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      enum: [1, 2, 2, null, undefined, 3],
    }) as { enum?: unknown };

    expect(cleaned.enum).toStrictEqual(["1", "2", "3"]);
  });

  it("stringifies nested numeric enums while preserving their number type", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        outer: {
          type: "array",
          items: {
            type: "object",
            properties: {
              score: { type: "number", enum: [1, 2, 3, 4, 5] },
            },
          },
        },
      },
    }) as {
      properties?: {
        outer?: { items?: { properties?: { score?: { type?: unknown; enum?: unknown } } } };
      };
    };

    const score = cleaned.properties?.outer?.items?.properties?.score;
    expect(score?.type).toBe("number");
    expect(score?.enum).toStrictEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns no enum key when array becomes empty after coercion", () => {
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      enum: [null, undefined, {}],
    }) as { enum?: unknown };

    expect(cleaned.enum).toBeUndefined();
  });

  it("preserves shared definitions across inline and reference traversal", () => {
    const node = {
      type: "object",
      properties: { next: { $ref: "#/$defs/Node" } },
    };
    expect(
      cleanSchemaForGemini({
        type: "object",
        $defs: { Node: node },
        properties: { head: node },
        required: ["head"],
      }),
    ).toStrictEqual({
      type: "object",
      properties: {
        head: {
          type: "object",
          properties: { next: { type: "object", properties: { next: {} } } },
        },
      },
      required: ["head"],
    });
  });
});
