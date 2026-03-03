import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { filterToolsByPolicy } from "./pi-tools.policy.js";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}

describe('tool profile "none"', () => {
  it("resolves to a deny-all policy", () => {
    const policy = resolveCoreToolProfilePolicy("none");
    expect(policy).toBeDefined();
    expect(policy!.deny).toEqual(["*"]);
  });

  it("filters out all tools when applied", () => {
    const tools = [
      createStubTool("read"),
      createStubTool("write"),
      createStubTool("exec"),
      createStubTool("browser"),
    ];
    const policy = resolveCoreToolProfilePolicy("none")!;
    const filtered = filterToolsByPolicy(tools, policy);
    expect(filtered).toEqual([]);
  });
});
