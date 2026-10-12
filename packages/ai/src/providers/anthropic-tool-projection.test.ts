import { describe, expect, it } from "vitest";
import { projectAnthropicTools } from "./anthropic-tool-projection.js";

describe("projectAnthropicTools", () => {
  it("retains same-original duplicates while sorting their descriptions", () => {
    const projection = projectAnthropicTools(
      ["Zulu", "Alpha"].map((description) => ({
        name: "Read",
        description,
        parameters: { type: "object", properties: {} },
      })),
      (name) => name.toLowerCase(),
    );

    expect(projection.inputToolCount).toBe(2);
    expect(projection.unavailableOriginalNames).toEqual(new Set());
    expect(projection.tools).toEqual([
      {
        originalName: "Read",
        wireName: "read",
        description: "Alpha",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        originalName: "Read",
        wireName: "read",
        description: "Zulu",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]);
  });

  it.each([{ names: ["Read", "Read", "read"], first: "Read", last: "read" }])(
    "keeps the first accepted spelling in a collision after $first duplicates",
    ({ names, first, last }) => {
      expect(() =>
        projectAnthropicTools(
          names.map((name) => ({ name, description: name, parameters: { type: "object" } })),
          () => "Read",
        ),
      ).toThrow(`Anthropic tool names "${first}" and "${last}" both map to "Read"`);
    },
  );

  it.each([
    { name: "implicit dialect", dialect: undefined, definitionsKey: "$defs" },
    {
      name: "explicit draft-07",
      dialect: "http://json-schema.org/draft-07/schema#",
      definitionsKey: "definitions",
    },
  ])(
    "preserves root constraints and tuple definitions for $name",
    ({ dialect, definitionsKey }) => {
      const parameters = {
        ...(dialect ? { $schema: dialect } : {}),
        type: "object",
        properties: { range: { $ref: `#/${definitionsKey}/Range` } },
        required: ["range"],
        additionalProperties: false,
        allOf: [{ propertyNames: { enum: ["range"] } }],
        [definitionsKey]: {
          Range: {
            ...(dialect ? { $schema: dialect } : {}),
            type: "array",
            items: [{ type: "integer" }, { type: "integer" }],
            additionalItems: false,
          },
          Trailing: {
            ...(dialect ? { $schema: dialect } : {}),
            type: "array",
            items: [],
          },
        },
      };
      const original = structuredClone(parameters);
      const projection = projectAnthropicTools(
        [{ name: "select_range", description: "Select a range", parameters }],
        (name) => name,
      );

      expect(projection.tools[0]?.inputSchema).toEqual({
        type: "object",
        properties: parameters.properties,
        required: ["range"],
        additionalProperties: false,
        allOf: parameters.allOf,
        [definitionsKey]: {
          Range: {
            type: "array",
            prefixItems: [{ type: "integer" }, { type: "integer" }],
            items: false,
          },
          Trailing: { type: "array", prefixItems: [] },
        },
      });
      expect(parameters).toEqual(original);
    },
  );

  it("quarantines Anthropic tools with non-finite numeric schema values", () => {
    const projection = projectAnthropicTools(
      [
        {
          name: "BadLimits",
          description: "Read a numeric value",
          parameters: {
            type: "object",
            properties: {
              amount: { type: "number", maximum: Number.POSITIVE_INFINITY },
            },
          },
        },
        {
          name: "Lookup",
          description: "Lookup a value",
          parameters: { type: "object", properties: {} },
        },
      ],
      (name) => name.toLowerCase(),
    );

    expect(projection.tools).toHaveLength(1);
    expect(projection.tools[0]?.wireName).toBe("lookup");
    expect(projection.unavailableOriginalNames).toEqual(new Set(["BadLimits"]));
  });
});
