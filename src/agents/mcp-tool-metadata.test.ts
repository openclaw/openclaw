import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { normalizeMcpToolCatalog } from "./mcp-tool-metadata.js";

function tool(name: string, overrides: Partial<Tool> = {}): Tool {
  return { name, inputSchema: { type: "object" }, ...overrides };
}

describe("normalizeMcpToolCatalog", () => {
  it.each([
    ["IDN hosts", "https://bücher.example/value", "https://xn--bcher-kva.example/value"],
    ["relative references", "child", "./child"],
    ["local fragments", "#value", "#value"],
    ["reserved path escapes", "a%3Ab", "a%3Ab"],
    [
      "draft-2020 embedded resources",
      "value",
      "./value",
      "https://json-schema.org/draft/2020-12/schema",
    ],
  ])("validates tool output schemas with %s", (_label, id, ref, $schema?: string) => {
    const normalized = normalizeMcpToolCatalog(
      [
        tool("referenced", {
          outputSchema: {
            ...($schema ? { $schema } : {}),
            $id: "https://schema.example/root",
            type: "object",
            definitions: { value: { $id: id, type: "string" } },
            properties: { value: { $ref: ref } },
            required: ["value"],
          },
        }),
      ],
      createMcpJsonSchemaValidator(),
    );
    const validate = normalized.metadata.validatorForCall("referenced")!;

    expect(() => validate({ content: [], structuredContent: { value: "ok" } })).not.toThrow();
    expect(() => validate({ content: [], structuredContent: { value: 1 } })).toThrow(
      "Structured content does not match the tool's output schema",
    );
  });

  it("keeps nested hostname escapes distinct when resolving tool output schemas", () => {
    const validate = createMcpJsonSchemaValidator().getValidator({
      $id: "https://schema.example/root",
      definitions: {
        encoded: { $id: "https://127%252e0%252e0%252e1/value", const: "encoded" },
        plain: { $id: "https://127.0.0.1/value", const: "plain" },
      },
      $ref: "https://127%252e0%252e0%252e1/value",
    });

    expect(validate("encoded").valid).toBe(true);
    expect(validate("plain").valid).toBe(false);
  });

  it.each([
    ["encoded scheme delimiters", "%2f%2fschema.example:/value", "URI scheme is malformed"],
    ["invalid IPv6", "https://[1:2:3::4::5]/value", "URI host is malformed"],
    ["malformed percent escapes", "https://schema.example/%ZZ", "malformed percent-encoding"],
  ])("rejects %s in tool output schema references", (_label, ref, error) => {
    expect(() =>
      createMcpJsonSchemaValidator().getValidator({
        $id: "https://schema.example/root",
        definitions: { value: { $id: ref, type: "string" } },
        $ref: ref,
      }),
    ).toThrow(error);
  });

  it.each([
    {
      label: "trim-equivalent names",
      colliding: [tool("duplicate"), tool(" duplicate ")],
    },
    {
      label: "a required-task alias",
      colliding: [
        tool(" task ", { execution: { taskSupport: "optional" } }),
        tool("task", { execution: { taskSupport: "required" } }),
      ],
    },
  ])("rejects canonical collisions from $label", ({ colliding }) => {
    const normalized = normalizeMcpToolCatalog(
      [...colliding, tool("healthy")],
      createMcpJsonSchemaValidator(),
    );

    expect(normalized.tools.map((entry) => entry.name)).toEqual(["healthy"]);
    expect(normalized.deniedTools).toEqual([]);
    expect(normalized.excludedTools.map((entry) => entry.name)).toEqual(
      colliding.map((entry) => entry.name.trim()),
    );
    expect(normalized.metadata.validatorForCall(colliding[0]?.name.trim() ?? "")).toBeUndefined();
  });

  it("filters excluded tools before compiling their output schemas", () => {
    const normalized = normalizeMcpToolCatalog(
      [
        tool("healthy", {
          outputSchema: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          },
        }),
        tool("excluded", {
          outputSchema: { type: "object", $ref: "#/$defs/Missing" },
        }),
        tool("task_only", { execution: { taskSupport: "required" } }),
      ],
      createMcpJsonSchemaValidator(),
      (toolName) => (toolName === "excluded" ? "exclude" : "include"),
    );

    expect(normalized.tools.map((entry) => entry.name)).toEqual(["healthy"]);
    expect(normalized.excludedTools.map((entry) => entry.name)).toEqual(["excluded", "task_only"]);
    expect(normalized.metadata.validatorForCall("healthy")).toBeTypeOf("function");
    expect(normalized.metadata.validatorForCall("excluded")).toBeUndefined();
  });
});

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

describe("createMcpJsonSchemaValidator patternProperties preflight", () => {
  it("rejects nested-repetition patternProperties before TypeBox Compile", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "(a+)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects nested-repetition patternProperties under schema-valued dependencies", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        properties: { mode: { type: "string" } },
        dependencies: {
          mode: {
            type: "object",
            patternProperties: {
              "(a+)+$": { type: "string" },
            },
          },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects adjacent unbounded patternProperties on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "a*a*$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("accepts safe disjoint patternProperties on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    const validate = factory.getValidator<{ a?: string; bc?: string }>({
      $schema: DRAFT,
      type: "object",
      patternProperties: {
        "^(a|bc)+$": { type: "string" },
      },
      additionalProperties: true,
    });
    expect(validate({ a: "ok", bc: "ok" }).valid).toBe(true);
  });

  it("accepts disjoint character-class patternProperties on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    const validate = factory.getValidator<{ a?: string; cd?: string }>({
      $schema: DRAFT,
      type: "object",
      patternProperties: {
        "^([ab]|cd)+$": { type: "string" },
      },
      additionalProperties: true,
    });
    expect(validate({ a: "ok", cd: "ok" }).valid).toBe(true);
  });

  it("rejects nested alternatives that share a possible prefix on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^((a|b)|bb)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("accepts disjoint multi-character groups on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    const validate = factory.getValidator<{ abcd?: string }>({
      $schema: DRAFT,
      type: "object",
      patternProperties: {
        "^(ab)+(cd)+$": { type: "string" },
      },
      additionalProperties: true,
    });
    expect(validate({ abcd: "ok" }).valid).toBe(true);
  });

  it("rejects hex-escape alternatives that share a decoded prefix on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\x61|aa)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects non-ASCII whitespace overlap on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\s|[\\u00a0][\\u00a0])+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects semantically overlapping adjacent patternProperties on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "a*[a]*$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects unparsed alternating groups adjacent to overlapping repetitions on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(a|b)+b+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects noncapturing overlapping alternatives on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(?:a|aaa)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects backreference alternatives on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(a)(\\1|aa)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("accepts disjoint alternating groups adjacent to a different repetition on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    const validate = factory.getValidator<{ ac?: string; bbc?: string }>({
      $schema: DRAFT,
      type: "object",
      patternProperties: {
        "^(a|b)+c+$": { type: "string" },
      },
      additionalProperties: true,
    });
    expect(validate({ ac: "ok", bbc: "ok" }).valid).toBe(true);
  });

  it("rejects named backreferences on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(?<x>a)(\\k<x>|aa)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects class-backspace overlap on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^([\\b]|\\x08\\x08)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects lookahead-hidden overlapping alternatives on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^((?!b)a|aaaa)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects braced unicode identity-plus-quantifier without u on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\u{2}|u)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects control-escape overlap on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\cA|\\x01\\x01)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects nested alternative sequences that overlap adjacent groups on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^((ab|cd)e)+(abe)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects octal-escape overlapping alternatives on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\141|aaaa)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects collapsed overlapping sequences on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^((ab|[a]b)c|abcabc)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects backreferences that hide overlapping consumed lengths on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(ab)(\\1c|abcabc)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects word-boundary overlapping alternatives on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(a\\Bb|abab)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects leftover-octal overlapping alternatives on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\1414c|a4ca4c)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects inline case-flag overlapping alternatives on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^((?i:a)|AA)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects class control-escape overlap on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^([\\c_]|\\x1f\\x1f)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects non-Unicode property identity-escape overlap on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\p{L}c|p{L}cp{L}c)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects mixed Unicode code-point overlap on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\u{1F600}|😀😀)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects overlapping astral class ranges on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^([😀-🙏]|😀😀)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects overlapping escaped surrogate pairs on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\uD83D\\uDE00|😀😀)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects malformed control-escape overlap on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\c|\\\\c\\\\c)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects input-boundary overlapping alternatives on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(\\n^a|\\na\\na)+Z": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects equal-length lookaround overlapping alternatives on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "^(a|a(?=a))+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("accepts deterministic groups that share a first character on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    const validate = factory.getValidator<{ abac?: string }>({
      $schema: DRAFT,
      type: "object",
      patternProperties: {
        "^(ab)+(ac)+$": { type: "string" },
      },
      additionalProperties: true,
    });
    expect(validate({ abac: "ok" }).valid).toBe(true);
  });

  it(
    "accepts a long literal patternProperties key on the MCP entrypoint",
    { timeout: 2000 },
    () => {
      const factory = createMcpJsonSchemaValidator();
      const key = "a".repeat(20_000);
      const validate = factory.getValidator<Record<string, unknown>>({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          [key]: { type: "string" },
        },
        additionalProperties: true,
      });
      expect(validate({ [key]: "ok", zz: 1 }).valid).toBe(true);
    },
  );

  it("compiles empty JSON Schema patternProperties on the MCP entrypoint", () => {
    const factory = createMcpJsonSchemaValidator();
    const validate = factory.getValidator<{ x?: { mode?: string } }>({
      $schema: DRAFT,
      type: "object",
      patternProperties: {
        "": {
          type: "object",
          properties: { mode: { type: "string" } },
        },
      },
      additionalProperties: true,
    });
    expect(validate({ x: { mode: "auto" } }).valid).toBe(true);
  });

  it("still compiles safe draft-2020-12 schemas", () => {
    const factory = createMcpJsonSchemaValidator();
    const validate = factory.getValidator<{ name: string }>({
      $schema: DRAFT,
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(validate({ name: "ok" }).valid).toBe(true);
    expect(validate({}).valid).toBe(false);
  });
});
