// Adversarial plan-mode bypass suite (NON-NEGOTIABLE).
//
// Proves that when a session is in plan mode, EVERY tool-dispatch flavor that funnels through
// the single before_tool_call choke point is vetoed: the exec tool, an MCP-named tool, a
// plugin tool, and the subagent-spawn tool. If any of these bypassed the gate, plan mode
// would not be a real read-only boundary.
import { describe, expect, it } from "vitest";
import { upsertSessionEntry } from "../../config/sessions/store.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runBeforeToolCallHook } from "../agent-tools.before-tool-call.js";

describe("plan-mode adversarial bypass suite", () => {
  const fixture = useTempSessionsFixture("openclaw-plan-adversarial-");
  const sessionKey = "agent:main:telegram:direct:900";

  async function enterPlanMode(): Promise<OpenClawConfig> {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-adv",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
        plan: { schemaVersion: 1, status: "planning", enteredAt: 1, updatedAt: 1 },
      },
    });
    return { session: { store: fixture.storePath() } } as OpenClawConfig;
  }

  async function callTool(config: OpenClawConfig, toolName: string, params: unknown) {
    return runBeforeToolCallHook({
      toolName,
      params,
      ctx: { sessionKey, agentId: "main", config },
    });
  }

  it("vetoes the exec tool (mutating command) in plan mode", async () => {
    const config = await enterPlanMode();
    const outcome = await callTool(config, "exec", { command: "rm -rf build" });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.kind).toBe("veto");
      expect(outcome.deniedReason).toBe("plan-mode");
      expect(outcome.reason).toMatch(/exit_plan_mode/);
    }
  });

  it("vetoes an MCP-named mutation tool in plan mode", async () => {
    const config = await enterPlanMode();
    const outcome = await callTool(config, "notion.write", { page: "x" });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.deniedReason).toBe("plan-mode");
    }
  });

  it("vetoes an unknown plugin tool in plan mode (default deny)", async () => {
    const config = await enterPlanMode();
    const outcome = await callTool(config, "acme_plugin_deploy", {});
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.deniedReason).toBe("plan-mode");
    }
  });

  it("vetoes the subagent-spawn tool in plan mode", async () => {
    const config = await enterPlanMode();
    const outcome = await callTool(config, "sessions_spawn", { prompt: "mutate things" });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.deniedReason).toBe("plan-mode");
    }
  });

  it("allows read-only tools through the gate in plan mode", async () => {
    const config = await enterPlanMode();
    const read = await callTool(config, "read", { path: "README.md" });
    expect(read.blocked).toBe(false);
    const execRead = await callTool(config, "exec", { command: "git status" });
    expect(execRead.blocked).toBe(false);
    const exit = await callTool(config, "exit_plan_mode", { plan_summary: "done" });
    expect(exit.blocked).toBe(false);
  });

  it("does not gate tools once plan mode is inactive", async () => {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-adv",
        updatedAt: 2,
        totalTokens: 0,
        totalTokensFresh: true,
        // No plan slot -> inactive.
      },
    });
    const config = { session: { store: fixture.storePath() } } as OpenClawConfig;
    const outcome = await callTool(config, "write", { path: "x", content: "y" });
    expect(outcome.blocked).toBe(false);
  });
});
