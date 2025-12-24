import { describe, expect, it } from "vitest";
import { createClawdisCodingTools } from "./pi-tools.js";

describe("createClawdisCodingTools", () => {
  it("merges properties for union tool schemas", () => {
    const tools = createClawdisCodingTools();
    const browser = tools.find((tool) => tool.name === "clawdis_browser");
    expect(browser).toBeDefined();
    const parameters = browser?.parameters as {
      anyOf?: unknown[];
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.anyOf?.length ?? 0).toBeGreaterThan(0);
    expect(parameters.properties?.action).toBeDefined();
    expect(parameters.properties?.controlUrl).toBeDefined();
    expect(parameters.properties?.targetUrl).toBeDefined();
    expect(parameters.properties?.request).toBeDefined();
    expect(parameters.required ?? []).toContain("action");
  });

  it("preserves union action values in merged schema", () => {
    const tools = createClawdisCodingTools();
    const toolNames = tools
      .filter((tool) => tool.name.startsWith("clawdis_"))
      .map((tool) => tool.name);

    for (const name of toolNames) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      const parameters = tool?.parameters as {
        anyOf?: Array<{ properties?: Record<string, unknown> }>;
        properties?: Record<string, unknown>;
      };
      const actionValues = new Set<string>();
      for (const variant of parameters.anyOf ?? []) {
        const action = variant?.properties?.action as
          | { const?: unknown; enum?: unknown[] }
          | undefined;
        if (typeof action?.const === "string") actionValues.add(action.const);
        if (Array.isArray(action?.enum)) {
          for (const value of action.enum) {
            if (typeof value === "string") actionValues.add(value);
          }
        }
      }

      const mergedAction = parameters.properties?.action as
        | { const?: unknown; enum?: unknown[] }
        | undefined;
      const mergedValues = new Set<string>();
      if (typeof mergedAction?.const === "string") {
        mergedValues.add(mergedAction.const);
      }
      if (Array.isArray(mergedAction?.enum)) {
        for (const value of mergedAction.enum) {
          if (typeof value === "string") mergedValues.add(value);
        }
      }

      expect(actionValues.size).toBeGreaterThan(1);
      expect(mergedValues.size).toBe(actionValues.size);
      for (const value of actionValues) {
        expect(mergedValues.has(value)).toBe(true);
      }
    }
  });
});
