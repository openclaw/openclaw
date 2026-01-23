import { describe, expect, it } from "vitest";
import { createClawdbotCodingTools } from "./pi-tools.js";

describe("createClawdbotCodingTools", () => {
  it("applies tool profiles before allow/deny policies", () => {
    const tools = createClawdbotCodingTools({
      config: { tools: { profile: "messaging" } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("sessions_send")).toBe(true);
    expect(names.has("sessions_spawn")).toBe(false);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });
  it("expands group shorthands in global tool policy", () => {
    const tools = createClawdbotCodingTools({
      config: { tools: { allow: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });
  it("expands group shorthands in global tool deny policy", () => {
    const tools = createClawdbotCodingTools({
      config: { tools: { deny: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(false);
    expect(names.has("write")).toBe(false);
    expect(names.has("edit")).toBe(false);
    expect(names.has("exec")).toBe(true);
  });
  it("lets agent profiles override global profiles", () => {
    const tools = createClawdbotCodingTools({
      sessionKey: "agent:work:main",
      config: {
        tools: { profile: "coding" },
        agents: {
          list: [{ id: "work", tools: { profile: "messaging" } }],
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("read")).toBe(false);
  });
  it("removes unsupported JSON Schema keywords for Cloud Code Assist API compatibility", () => {
    const tools = createClawdbotCodingTools();

    // Helper to recursively check schema for unsupported keywords
    const unsupportedKeywords = new Set([
      "patternProperties",
      "additionalProperties",
      "$schema",
      "$id",
      "$ref",
      "$defs",
      "definitions",
      "examples",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "multipleOf",
      "pattern",
      "format",
      "minItems",
      "maxItems",
      "uniqueItems",
      "minProperties",
      "maxProperties",
    ]);

    const findUnsupportedKeywords = (schema: unknown, path: string): string[] => {
      const found: string[] = [];
      if (!schema || typeof schema !== "object") return found;
      if (Array.isArray(schema)) {
        schema.forEach((item, i) => {
          found.push(...findUnsupportedKeywords(item, `${path}[${i}]`));
        });
        return found;
      }

      const record = schema as Record<string, unknown>;
      const properties =
        record.properties &&
        typeof record.properties === "object" &&
        !Array.isArray(record.properties)
          ? (record.properties as Record<string, unknown>)
          : undefined;
      if (properties) {
        for (const [key, value] of Object.entries(properties)) {
          found.push(...findUnsupportedKeywords(value, `${path}.properties.${key}`));
        }
      }

      for (const [key, value] of Object.entries(record)) {
        if (key === "properties") continue;
        if (unsupportedKeywords.has(key)) {
          found.push(`${path}.${key}`);
        }
        if (value && typeof value === "object") {
          found.push(...findUnsupportedKeywords(value, `${path}.${key}`));
        }
      }
      return found;
    };

    for (const tool of tools) {
      const violations = findUnsupportedKeywords(tool.parameters, `${tool.name}.parameters`);
      expect(violations).toEqual([]);
    }
  });
});
