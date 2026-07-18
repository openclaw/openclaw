import { describe, expect, it } from "vitest";
import {
  cleanSchemaForLlamacppGbnf,
  findLlamacppGbnfSchemaViolations,
} from "./clean-for-llamacpp-gbnf.js";

describe("cleanSchemaForLlamacppGbnf", () => {
  it("removes pattern and oversized maxLength while preserving other bounds", () => {
    const schema = {
      type: "object",
      properties: {
        declarationKey: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          pattern: "\\S",
        },
        script: {
          type: "string",
          minLength: 1,
          maxLength: 65_536,
        },
        query: {
          type: "string",
          maxLength: 4_096,
        },
        title: {
          type: "string",
          maxLength: 64,
        },
      },
    };

    expect(cleanSchemaForLlamacppGbnf(schema)).toEqual({
      type: "object",
      properties: {
        declarationKey: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        script: {
          type: "string",
          minLength: 1,
        },
        query: {
          type: "string",
        },
        title: {
          type: "string",
          maxLength: 64,
        },
      },
    });
  });

  it("recurses through composition and property containers", () => {
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            nested: { type: "string", pattern: "^foo$", maxLength: 8_192 },
          },
        },
      ],
    };

    expect(cleanSchemaForLlamacppGbnf(schema)).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            nested: { type: "string" },
          },
        },
      ],
    });
  });
});

describe("findLlamacppGbnfSchemaViolations", () => {
  it("reports pattern and oversized maxLength paths", () => {
    expect(
      findLlamacppGbnfSchemaViolations(
        {
          type: "object",
          properties: {
            key: { type: "string", pattern: "\\S", maxLength: 200 },
            script: { type: "string", maxLength: 65_536 },
          },
        },
        "demo.parameters",
      ),
    ).toEqual([
      "demo.parameters.properties.key.pattern",
      "demo.parameters.properties.script.maxLength",
    ]);
  });
});
