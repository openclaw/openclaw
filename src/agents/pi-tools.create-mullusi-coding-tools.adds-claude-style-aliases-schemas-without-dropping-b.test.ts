import { describe, expect, it } from "vitest";
import type { MullusiConfig } from "../config/config.js";
import "./test-helpers/fast-coding-tools.js";
import { createMullusiCodingTools } from "./pi-tools.js";

const defaultTools = createMullusiCodingTools({ senderIsOwner: true });

describe("createMullusiCodingTools", () => {
  it("preserves action enums in normalized schemas", () => {
    const toolNames = ["canvas", "nodes", "cron", "gateway", "message"];
    const missingNames = toolNames.filter(
      (name) => !defaultTools.some((candidate) => candidate.name === name),
    );
    expect(missingNames).toEqual([]);

    const collectActionValues = (schema: unknown, values: Set<string>): void => {
      if (!schema || typeof schema !== "object") {
        return;
      }
      const record = schema as Record<string, unknown>;
      if (typeof record.const === "string") {
        values.add(record.const);
      }
      if (Array.isArray(record.enum)) {
        for (const value of record.enum) {
          if (typeof value === "string") {
            values.add(value);
          }
        }
      }
      if (Array.isArray(record.anyOf)) {
        for (const variant of record.anyOf) {
          collectActionValues(variant, values);
        }
      }
    };

    for (const name of toolNames) {
      const tool = defaultTools.find((candidate) => candidate.name === name);
      const parameters = tool?.parameters as {
        properties?: Record<string, unknown>;
      };
      const action = parameters.properties?.action as
        | { const?: unknown; enum?: unknown[] }
        | undefined;
      const values = new Set<string>();
      collectActionValues(action, values);

      const min =
        name === "gateway"
          ? 1
          : // Most tools expose multiple actions; keep this signal so schemas stay useful to models.
            2;
      expect(values.size).toBeGreaterThanOrEqual(min);
    }
  });
  it("enforces apply_patch availability and canonical names across model/provider constraints", () => {
    expect(defaultTools.some((tool) => tool.name === "exec")).toBe(true);
    expect(defaultTools.some((tool) => tool.name === "process")).toBe(true);
    expect(defaultTools.some((tool) => tool.name === "apply_patch")).toBe(false);

    const openAiTools = createMullusiCodingTools({
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(openAiTools.some((tool) => tool.name === "apply_patch")).toBe(true);

    const codexTools = createMullusiCodingTools({
      modelProvider: "openai-codex",
      modelId: "gpt-5.4",
    });
    expect(codexTools.some((tool) => tool.name === "apply_patch")).toBe(true);

    const disabledConfig: MullusiConfig = {
      tools: {
        exec: {
          applyPatch: { enabled: false },
        },
      },
    };
    const disabledOpenAiTools = createMullusiCodingTools({
      config: disabledConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(disabledOpenAiTools.some((tool) => tool.name === "apply_patch")).toBe(false);

    const anthropicTools = createMullusiCodingTools({
      config: disabledConfig,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(anthropicTools.some((tool) => tool.name === "apply_patch")).toBe(false);

    const allowModelsConfig: MullusiConfig = {
      tools: {
        exec: {
          applyPatch: { allowModels: ["gpt-5.4"] },
        },
      },
    };
    const allowed = createMullusiCodingTools({
      config: allowModelsConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(allowed.some((tool) => tool.name === "apply_patch")).toBe(true);

    const denied = createMullusiCodingTools({
      config: allowModelsConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(denied.some((tool) => tool.name === "apply_patch")).toBe(false);

    const oauthTools = createMullusiCodingTools({
      modelProvider: "anthropic",
      modelAuthMode: "oauth",
    });
    const names = new Set(oauthTools.map((tool) => tool.name));
    expect(names.has("exec")).toBe(true);
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("apply_patch")).toBe(false);
  });
  it("provides top-level object schemas for all tools", () => {
    const tools = createMullusiCodingTools();
    const offenders = tools
      .map((tool) => {
        const schema =
          tool.parameters && typeof tool.parameters === "object"
            ? (tool.parameters as Record<string, unknown>)
            : null;
        return {
          name: tool.name,
          type: schema?.type,
          keys: schema ? Object.keys(schema).toSorted() : null,
        };
      })
      .filter((entry) => entry.type !== "object");

    expect(offenders).toEqual([]);
  });
});
