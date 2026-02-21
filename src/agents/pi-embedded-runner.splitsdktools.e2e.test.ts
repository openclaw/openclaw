import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { splitSdkTools } from "./pi-embedded-runner.js";

type DurationProbeResult = AgentToolResult<unknown> & {
  durationMs?: number;
  metadata?: { durationMs?: number };
};

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}

describe("splitSdkTools", () => {
  const tools = [
    createStubTool("read"),
    createStubTool("exec"),
    createStubTool("edit"),
    createStubTool("write"),
    createStubTool("browser"),
  ];

  it("routes all tools to customTools when sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: true,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("routes all tools to customTools even when not sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: false,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("disables tool result duration injection when configured off", async () => {
    const probeTool: AgentTool = {
      name: "probe",
      label: "probe",
      description: "",
      parameters: {},
      execute: async () =>
        ({ content: [{ type: "text", text: "ok" }] }) as AgentToolResult<unknown>,
    };

    const { customTools } = splitSdkTools({
      tools: [probeTool],
      sandboxEnabled: false,
      recordToolResultDurations: false,
    });

    const result = (await customTools[0].execute(
      "probe-call",
      {},
      undefined,
      undefined,
      undefined,
    )) as DurationProbeResult;

    expect(result.durationMs).toBeUndefined();
    expect(result.metadata?.durationMs).toBeUndefined();
  });

  it("keeps tool result duration injection enabled by default", async () => {
    const probeTool: AgentTool = {
      name: "probeOn",
      label: "probeOn",
      description: "",
      parameters: {},
      execute: async () =>
        ({ content: [{ type: "text", text: "ok" }] }) as AgentToolResult<unknown>,
    };

    const { customTools } = splitSdkTools({
      tools: [probeTool],
      sandboxEnabled: false,
    });

    const result = (await customTools[0].execute(
      "probe-call-on",
      {},
      undefined,
      undefined,
      undefined,
    )) as DurationProbeResult;

    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.metadata?.durationMs).toBe("number");
  });
});
