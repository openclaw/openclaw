import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../../pi-tools.types.js";
import { sessionMacroMapper } from "./session.js";

function mockTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: "Mock tool",
    parameters: {},
    execute: async () => ({ type: "text", text: "ok" }),
  } as unknown as AnyAgentTool;
}

const availableTools = new Map<string, AnyAgentTool>([
  ["sessions_list", mockTool("sessions_list")],
  ["session_status", mockTool("session_status")],
  ["sessions_history", mockTool("sessions_history")],
  ["sessions_send", mockTool("sessions_send")],
  ["sessions_spawn", mockTool("sessions_spawn")],
  ["subagents", mockTool("subagents")],
]);

describe("sessionMacroMapper", () => {
  it("defaults to sessions_list when no arguments provided", () => {
    const result = sessionMacroMapper.resolveMacro([], availableTools);
    expect(result).not.toBeNull();
    expect(result?.tool.name).toBe("sessions_list");
    expect(result?.commandArgs).toEqual({});
  });

  it("routes to sessions_list with limits when flags are provided", () => {
    const result = sessionMacroMapper.resolveMacro(["--limit", "5"], availableTools);
    expect(result?.tool.name).toBe("sessions_list");
    expect(result?.commandArgs).toEqual({ limit: 5 });
  });

  it("routes to subagents list", () => {
    const result = sessionMacroMapper.resolveMacro(["--subagents"], availableTools);
    expect(result?.tool.name).toBe("subagents");
    expect(result?.commandArgs).toEqual({});
  });

  it("routes to sessions_spawn", () => {
    const result = sessionMacroMapper.resolveMacro(
      ["--spawn", "--agent", "coding"],
      availableTools,
    );
    expect(result?.tool.name).toBe("sessions_spawn");
    expect(result?.commandArgs).toEqual({ agent: "coding" });
  });

  it("routes to session_status when an ID is provided", () => {
    const result = sessionMacroMapper.resolveMacro(["sess_123"], availableTools);
    expect(result?.tool.name).toBe("session_status");
    expect(result?.commandArgs).toEqual({ session_id: "sess_123" });
  });

  it("routes to sessions_history when --log flag is used", () => {
    const result = sessionMacroMapper.resolveMacro(
      ["sess_123", "--log", "--limit", "10"],
      availableTools,
    );
    expect(result?.tool.name).toBe("sessions_history");
    expect(result?.commandArgs).toEqual({ session_id: "sess_123", limit: 10 });
  });

  it("routes to sessions_history when --history flag is used", () => {
    const result = sessionMacroMapper.resolveMacro(["sess_123", "--history"], availableTools);
    expect(result?.tool.name).toBe("sessions_history");
    expect(result?.commandArgs).toEqual({ session_id: "sess_123" });
  });

  it("routes to sessions_send when --send flag is used", () => {
    const result = sessionMacroMapper.resolveMacro(
      ["sess_123", "--send", "hello world"],
      availableTools,
    );
    expect(result?.tool.name).toBe("sessions_send");
    expect(result?.commandArgs).toEqual({ session_id: "sess_123", message: "hello world" });
  });

  it("returns null if the required underlying tool is not authorized/available", () => {
    const restrictedTools = new Map<string, AnyAgentTool>([
      ["sessions_list", mockTool("sessions_list")],
    ]);
    // sessions_history is NOT in the restrictedTools map
    const result = sessionMacroMapper.resolveMacro(["sess_123", "--history"], restrictedTools);
    expect(result).toBeNull();
  });
});
