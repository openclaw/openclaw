import { describe, expect, it } from "vitest";
import type { Model } from "../../../llm-core/src/index.js";
import type { AgentTool } from "../types.js";
import { AgentHarness } from "./agent-harness.js";
import type { ExecutionEnv, Session } from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function createTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [], details: undefined }),
  } as AgentTool;
}

function createUnreadableNameTool(): AgentTool {
  const tool = createTool("placeholder");
  Object.defineProperty(tool, "name", {
    get() {
      throw new Error("tool name getter exploded");
    },
  });
  return tool;
}

function createHarness(tools: AgentTool[] = []): AgentHarness {
  return new AgentHarness({
    env: {} as ExecutionEnv,
    session: {} as Session,
    model,
    tools,
  });
}

describe("AgentHarness tool registry", () => {
  it("ignores tool descriptors with unreadable names during construction", () => {
    expect(() => createHarness([createUnreadableNameTool(), createTool("healthy")])).not.toThrow();
  });

  it("treats unreadable tool names as absent when replacing tools", async () => {
    const harness = createHarness([createTool("healthy")]);

    await expect(harness.setTools([createUnreadableNameTool()], ["broken"])).rejects.toMatchObject({
      name: "AgentHarnessError",
      code: "invalid_argument",
      message: "Unknown tool(s): broken",
    });
  });
});
