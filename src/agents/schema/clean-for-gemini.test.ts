import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini", () => {
  it("coerces null properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: null,
    }) as { type?: unknown; properties?: unknown };

    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toEqual({});
  });

  it("coerces non-object properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: "invalid",
    }) as { properties?: unknown };

    expect(cleaned.properties).toEqual({});
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

    expect(cleaned.properties?.bad?.properties).toEqual({});
    expect(cleaned.properties?.good?.type).toBe("string");
  });
});
