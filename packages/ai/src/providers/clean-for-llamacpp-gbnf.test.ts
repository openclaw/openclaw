import { describe, expect, it } from "vitest";
import { cleanSchemaForLlamacppGbnf, isLlamacppGbnfToolSchemaProvider } from "./clean-for-llamacpp-gbnf.js";

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

describe("isLlamacppGbnfToolSchemaProvider", () => {
  it("matches the explicit llamacpp profile", () => {
    expect(
      isLlamacppGbnfToolSchemaProvider({ toolSchemaProfile: "llamacpp", modelProvider: "openai" }),
    ).toBe(true);
  });

  it("matches known llama.cpp-backed provider ids", () => {
    for (const provider of ["ollama", "lmstudio", "llama-cpp", "llamacpp", "my-llama.cpp-host"]) {
      expect(isLlamacppGbnfToolSchemaProvider({ modelProvider: provider })).toBe(true);
    }
  });

  it("does not match unrelated providers", () => {
    expect(isLlamacppGbnfToolSchemaProvider({ modelProvider: "openai" })).toBe(false);
    expect(isLlamacppGbnfToolSchemaProvider({ modelProvider: "anthropic" })).toBe(false);
  });
});
