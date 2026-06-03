import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../runtime/index.js";
import { createToolDefinitionFromAgentTool } from "./tool-definition-wrapper.js";

describe("createToolDefinitionFromAgentTool", () => {
  it("falls back to registry metadata when agent tool descriptor fields are unreadable", async () => {
    const tool = {
      get name() {
        throw new Error("session tool name getter exploded");
      },
      get label() {
        throw new Error("session tool label getter exploded");
      },
      get description() {
        throw new Error("session tool description getter exploded");
      },
      get parameters() {
        throw new Error("session tool parameters getter exploded");
      },
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    } as unknown as AgentTool;

    const definition = createToolDefinitionFromAgentTool(tool, "base_read");

    expect(definition.name).toBe("base_read");
    expect(definition.label).toBe("base_read");
    expect(definition.description).toBe("");
    expect(definition.parameters).toMatchObject({ type: "object", properties: {} });
    await expect(
      definition.execute("call-1", {}, undefined, undefined, {} as never),
    ).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
      details: {},
    });
  });

  it("preserves readable agent tool metadata", () => {
    const parameters = Type.Object({ query: Type.String() });
    const prepareArguments = (args: unknown) => args as { query: string };
    const tool = {
      name: "custom_lookup",
      label: "Custom Lookup",
      description: "Looks up a test value.",
      parameters,
      prepareArguments,
      executionMode: "sequential",
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    } satisfies AgentTool<typeof parameters>;

    const definition = createToolDefinitionFromAgentTool(tool, "fallback_lookup");

    expect(definition).toMatchObject({
      name: "custom_lookup",
      label: "Custom Lookup",
      description: "Looks up a test value.",
      parameters,
      prepareArguments,
      executionMode: "sequential",
    });
  });
});
