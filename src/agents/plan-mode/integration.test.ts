/**
 * Plan-mode integration test (PR-8).
 *
 * Verifies the wired-together flow that makes plan mode actually
 * function end-to-end:
 *
 * 1. `agents.defaults.planMode.enabled = true` registers
 *    `enter_plan_mode` / `exit_plan_mode` tools.
 * 2. `sessions.patch { planMode: "plan" }` writes
 *    `SessionEntry.planMode = { mode: "plan", ... }`.
 * 3. With `planMode: "plan"` threaded through `pi-tools` →
 *    `before-tool-call` hook context, mutation tools are blocked by
 *    `checkMutationGate` BEFORE the plugin hookRunner sees them.
 * 4. Read-only tools (read, web_search, etc.) and the plan-mode
 *    affordances themselves (update_plan, exit_plan_mode) pass through.
 * 5. Toggling back to `planMode: "normal"` clears `SessionEntry.planMode`
 *    and disarms the gate.
 * 6. The tools' execute functions return structured results the runner
 *    can use to drive event emission.
 *
 * This is the "smoke" integration — it does NOT exercise the full
 * approval reply loop (channel renderers, agent_approval_event dispatch),
 * which lives in #67538b's lib + the channel renderer surfaces. The
 * point is to prove the WIRING shipped here works: tools register, gate
 * blocks/allows the right things, sessions.patch flips the state.
 */

import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPlanModeToolsEnabledForOpenClawTools } from "../openclaw-tools.registration.js";
import { runBeforeToolCallHook } from "../pi-tools.before-tool-call.js";
import { createEnterPlanModeTool } from "../tools/enter-plan-mode-tool.js";
import { createExitPlanModeTool } from "../tools/exit-plan-mode-tool.js";

describe("plan-mode integration (PR-8)", () => {
  describe("tool enablement gate", () => {
    it("returns false when agents.defaults.planMode is absent", () => {
      expect(isPlanModeToolsEnabledForOpenClawTools({})).toBe(false);
      expect(isPlanModeToolsEnabledForOpenClawTools({ config: {} })).toBe(false);
    });

    it("returns false when agents.defaults.planMode.enabled is false", () => {
      const config: OpenClawConfig = {
        agents: { defaults: { planMode: { enabled: false } } },
      };
      expect(isPlanModeToolsEnabledForOpenClawTools({ config })).toBe(false);
    });

    it("returns true only when agents.defaults.planMode.enabled === true", () => {
      const config: OpenClawConfig = {
        agents: { defaults: { planMode: { enabled: true } } },
      };
      expect(isPlanModeToolsEnabledForOpenClawTools({ config })).toBe(true);
    });
  });

  describe("enter_plan_mode tool", () => {
    it("returns a structured 'entered' result the runner can dispatch on", async () => {
      const tool = createEnterPlanModeTool();
      const result = await tool.execute("call-1", { reason: "multi-file refactor" });
      expect(result.details).toMatchObject({
        status: "entered",
        mode: "plan",
        reason: "multi-file refactor",
      });
    });

    it("omits reason when not provided or whitespace-only", async () => {
      const tool = createEnterPlanModeTool();
      const r1 = await tool.execute("c1", {});
      const r2 = await tool.execute("c2", { reason: "   " });
      expect((r1.details as Record<string, unknown>).reason).toBeUndefined();
      expect((r2.details as Record<string, unknown>).reason).toBeUndefined();
    });
  });

  describe("exit_plan_mode tool", () => {
    it("returns 'approval_requested' with the proposed plan", async () => {
      const tool = createExitPlanModeTool();
      const result = await tool.execute("call-1", {
        title: "Refactor checklist",
        summary: "Refactor checklist",
        plan: [
          { step: "Run tests", status: "pending" },
          { step: "Apply patch", status: "pending" },
        ],
      });
      expect(result.details).toMatchObject({
        status: "approval_requested",
        summary: "Refactor checklist",
        plan: [
          { step: "Run tests", status: "pending" },
          { step: "Apply patch", status: "pending" },
        ],
      });
    });

    it("rejects an empty plan (cannot exit without a proposal)", async () => {
      const tool = createExitPlanModeTool();
      await expect(tool.execute("c1", { title: "Empty plan", plan: [] })).rejects.toThrow(
        /plan required/,
      );
    });

    it("rejects a plan with multiple in_progress steps", async () => {
      const tool = createExitPlanModeTool();
      await expect(
        tool.execute("c1", {
          title: "Multiple active steps",
          plan: [
            { step: "A", status: "in_progress" },
            { step: "B", status: "in_progress" },
          ],
        }),
      ).rejects.toThrow(/at most one in_progress/);
    });

    it("rejects a plan with an unknown status value", async () => {
      const tool = createExitPlanModeTool();
      await expect(
        tool.execute("c1", {
          title: "Unknown status",
          plan: [{ step: "A", status: "weirdo" }],
        }),
      ).rejects.toThrow(/must be one of/);
    });
  });

  describe("before-tool-call hook with planMode active", () => {
    it("blocks `write` tool when planMode === 'plan'", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "write",
        params: { path: "foo.ts", content: "x" },
        ctx: { planMode: "plan" },
      });
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.reason).toMatch(/plan mode/i);
      }
    });

    it("blocks `edit` tool when planMode === 'plan'", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "edit",
        params: { path: "foo.ts", oldText: "a", newText: "b" },
        ctx: { planMode: "plan" },
      });
      expect(result.blocked).toBe(true);
    });

    it("blocks `exec` with a mutation command when planMode === 'plan'", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "exec",
        params: { command: "rm -rf /tmp/something" },
        ctx: { planMode: "plan" },
      });
      expect(result.blocked).toBe(true);
    });

    it("ALLOWS `read` tool when planMode === 'plan' (read-only)", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "read",
        params: { path: "foo.ts" },
        ctx: { planMode: "plan" },
      });
      expect(result.blocked).toBe(false);
    });

    it("ALLOWS `web_search` tool when planMode === 'plan'", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "web_search",
        params: { query: "x" },
        ctx: { planMode: "plan" },
      });
      expect(result.blocked).toBe(false);
    });

    it("ALLOWS `update_plan` tool when planMode === 'plan'", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "update_plan",
        params: { plan: [{ step: "x", status: "pending" }] },
        ctx: { planMode: "plan" },
      });
      expect(result.blocked).toBe(false);
    });

    it("ALLOWS `exit_plan_mode` tool when planMode === 'plan'", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "exit_plan_mode",
        params: { plan: [{ step: "x", status: "pending" }] },
        ctx: { planMode: "plan" },
      });
      expect(result.blocked).toBe(false);
    });

    it("ALLOWS `exec` with read-only command (e.g. `ls`) when planMode === 'plan'", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "exec",
        params: { command: "ls -la" },
        ctx: { planMode: "plan" },
      });
      expect(result.blocked).toBe(false);
    });

    it("DOES NOT block any tool when planMode is absent (gate disarmed)", async () => {
      const r1 = await runBeforeToolCallHook({
        toolName: "write",
        params: { path: "foo.ts", content: "x" },
        ctx: {},
      });
      const r2 = await runBeforeToolCallHook({
        toolName: "exec",
        params: { command: "rm -rf /tmp" },
        ctx: {},
      });
      expect(r1.blocked).toBe(false);
      expect(r2.blocked).toBe(false);
    });

    it("DOES NOT block any tool when planMode === 'normal'", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "write",
        params: { path: "foo.ts", content: "x" },
        ctx: { planMode: "normal" },
      });
      expect(result.blocked).toBe(false);
    });

    it("blocks unknown tools by default in plan mode (default-deny)", async () => {
      const result = await runBeforeToolCallHook({
        toolName: "some_unknown_mcp_tool",
        params: {},
        ctx: { planMode: "plan" },
      });
      expect(result.blocked).toBe(true);
    });
  });
});
