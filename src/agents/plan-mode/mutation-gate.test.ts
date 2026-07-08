// Plan-mode mutation gate matrix: allowlist / blocklist / suffix / exec-prefix / dangerous flags.
import { describe, expect, it } from "vitest";
import { checkPlanModeMutationGate } from "./mutation-gate.js";

function gate(toolName: string, toolParams?: unknown) {
  return checkPlanModeMutationGate({ toolName, planActive: true, toolParams });
}

describe("checkPlanModeMutationGate", () => {
  it("blocks nothing when plan mode is inactive", () => {
    expect(checkPlanModeMutationGate({ toolName: "write", planActive: false }).blocked).toBe(false);
  });

  it("allows read-only allowlist tools", () => {
    for (const name of [
      "read",
      "ls",
      "grep",
      "find",
      "search",
      "web_fetch",
      "web_search",
      "active_memory_search",
      "update_plan",
      "enter_plan_mode",
      "exit_plan_mode",
      "ask_user_question",
      "get_goal",
      "sessions_history",
    ]) {
      expect(gate(name).blocked, name).toBe(false);
    }
  });

  it("blocks subagent spawning (a spawned child runs outside the gate)", () => {
    expect(gate("sessions_spawn").blocked).toBe(true);
    expect(gate("subagents").blocked).toBe(true);
  });

  it("vetoes mutating built-in tools with an instructive message", () => {
    for (const name of ["write", "edit", "apply_patch", "message", "gateway", "browser", "nodes"]) {
      const result = gate(name);
      expect(result.blocked, name).toBe(true);
      if (result.blocked) {
        expect(result.reason).toMatch(/exit_plan_mode/);
      }
    }
  });

  it("vetoes active_memory_store (write variant) while allowing the search variant", () => {
    expect(gate("active_memory_store").blocked).toBe(true);
    expect(gate("active_memory_search").blocked).toBe(false);
  });

  it("allows exec/bash with a read-only command prefix", () => {
    expect(gate("bash", { command: "ls -la" }).blocked).toBe(false);
    expect(gate("exec", { command: "git status" }).blocked).toBe(false);
    expect(gate("bash", { cmd: "cat package.json" }).blocked).toBe(false);
  });

  it("vetoes exec/bash with a mutating command", () => {
    expect(gate("bash", { command: "rm -rf build" }).blocked).toBe(true);
    expect(gate("exec", { command: "npm install" }).blocked).toBe(true);
    // No command supplied -> falls through to blocklist veto.
    expect(gate("exec").blocked).toBe(true);
  });

  it("vetoes read-only prefixes abused with shell operators", () => {
    expect(gate("bash", { command: "cat secrets | tee out" }).blocked).toBe(true);
    expect(gate("bash", { command: "ls; rm -rf /" }).blocked).toBe(true);
    expect(gate("bash", { command: "cat a > b" }).blocked).toBe(true);
    expect(gate("bash", { command: "echo $(whoami)" }).blocked).toBe(true);
  });

  it("vetoes dangerous flags even on read-only prefixes", () => {
    expect(gate("bash", { command: "find . -delete" }).blocked).toBe(true);
    expect(gate("bash", { command: "find . -exec rm {} ;" }).blocked).toBe(true);
    // -executable must NOT false-match the -exec dangerous flag.
    expect(gate("bash", { command: "find . -type f -executable" }).blocked).toBe(false);
  });

  it("vetoes MCP mutation-suffix tools and allows read-suffix tools", () => {
    expect(gate("custom.write").blocked).toBe(true);
    expect(gate("vault.delete").blocked).toBe(true);
    expect(gate("repo.edit").blocked).toBe(true);
    expect(gate("custom.read").blocked).toBe(false);
    expect(gate("data.search").blocked).toBe(false);
    expect(gate("repo.list").blocked).toBe(false);
  });

  it("default-denies unknown / newly-added / plugin tools (fail closed)", () => {
    const result = gate("some_new_plugin_tool");
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toMatch(/not in the plan-mode read-only allowlist/);
    }
  });
});
