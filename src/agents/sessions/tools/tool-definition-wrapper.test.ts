import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../runtime/index.js";
import type { ToolDefinition } from "../extensions/types.js";
import {
  createToolDefinitionsFromAgentTools,
  snapshotSessionToolDefinitions,
  wrapToolDefinitions,
} from "./tool-definition-wrapper.js";

function createUnreadableParametersDefinition(name: string): ToolDefinition {
  const definition = {
    name,
    label: name,
    description: "bad schema",
    execute: async () => ({
      content: [{ type: "text" as const, text: "bad" }],
    }),
  } as ToolDefinition;
  Object.defineProperty(definition, "parameters", {
    get: () => {
      throw new Error("revoked schema");
    },
  });
  return definition;
}

describe("session tool definition wrapper", () => {
  it("skips unreadable ToolDefinition schemas while preserving healthy siblings", () => {
    const healthy = {
      name: "healthy_lookup",
      label: "Healthy Lookup",
      description: "survives bad siblings",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    } satisfies ToolDefinition;

    const tools = wrapToolDefinitions([
      createUnreadableParametersDefinition("bad_lookup"),
      healthy,
    ]);

    expect(tools.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
  });

  it("snapshots schemas without stripping TypeBox metadata", () => {
    const parameters = Type.Object({ query: Type.String() });
    const [snapshot] = snapshotSessionToolDefinitions([
      {
        name: "search",
        label: "Search",
        description: "searches",
        parameters,
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      },
    ]);
    if (!snapshot) {
      throw new Error("missing snapshot");
    }
    (parameters.properties.query as Record<string, unknown>).type = "number";

    expect(snapshot.parameters).not.toBe(parameters);
    expect(snapshot.parameters).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
    });
    expect(Object.getOwnPropertyDescriptor(snapshot.parameters, "~kind")).toMatchObject({
      value: "Object",
      enumerable: false,
    });
  });

  it("keeps tools that intentionally omit a parameter schema", () => {
    const [tool] = wrapToolDefinitions([
      {
        name: "no_args",
        label: "No Args",
        description: "accepts no arguments",
        parameters: undefined as never,
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      },
    ]);

    expect(tool?.name).toBe("no_args");
    expect(tool?.parameters).toBeUndefined();
  });

  it("skips unreadable AgentTool schemas while preserving healthy base overrides", () => {
    const badTool = {
      name: "bad_override",
      label: "Bad Override",
      description: "bad schema",
      execute: async () => ({
        content: [{ type: "text" as const, text: "bad" }],
      }),
    } as AgentTool;
    Object.defineProperty(badTool, "parameters", {
      get: () => {
        throw new Error("revoked schema");
      },
    });
    const healthyTool = {
      name: "healthy_override",
      label: "Healthy Override",
      description: "survives bad overrides",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    } satisfies AgentTool;

    const definitions = createToolDefinitionsFromAgentTools({
      bad_override: badTool,
      healthy_override: healthyTool,
    });

    expect(Object.keys(definitions)).toEqual(["healthy_override"]);
  });
});
