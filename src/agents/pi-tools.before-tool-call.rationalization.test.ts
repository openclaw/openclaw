// RI-011 — rationalization engine wire tests
// Verifies that runBeforeToolCallHook actually routes through
// evaluateToolCall and blocks when a block-action rule matches.

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  __setRationalizationRulesForTest,
  type RationalizationRule,
} from "./governance/rationalization-engine.js";
import {
  __testing,
} from "./pi-tools.before-tool-call.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";

vi.mock("../plugins/hook-runner-global.js");
const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

const { runBeforeToolCallHook } = __testing;

describe("runBeforeToolCallHook — rationalization engine wiring", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    __setRationalizationRulesForTest(null);
    mockGetGlobalHookRunner.mockReturnValue({
      // oxlint-disable-next-line typescript/no-explicit-any
      hasHooks: vi.fn().mockReturnValue(false),
      runBeforeToolCall: vi.fn(),
    } as unknown as ReturnType<typeof getGlobalHookRunner>);
  });

  afterEach(() => {
    __setRationalizationRulesForTest(null);
  });

  it("blocks a tool call when a block-action rule matches the params", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf /" },
      toolCallId: "call-1",
      ctx: {
        agentId: "main",
        sessionKey: "session-a",
        loopDetection: { enabled: true },
      },
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("rm-rf-cleanup");
    }
  });

  it("blocks force-push to main even when loop detection is disabled", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "git push --force origin main" },
      toolCallId: "call-2",
      ctx: {
        agentId: "main",
        sessionKey: "session-b",
        loopDetection: { enabled: false },
      },
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("force-push-main-safe");
    }
  });

  it("does NOT block when only a warn-action rule matches", async () => {
    const warnOnly: RationalizationRule = {
      id: "warn-only-test",
      category: "testing",
      severity: "low",
      pattern: "ship.+yolo",
      rebuttal: "Don't ship yolo.",
      action: "warn",
    };
    __setRationalizationRulesForTest([warnOnly]);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "echo ship it yolo" },
      toolCallId: "call-3",
      ctx: {
        agentId: "main",
        sessionKey: "session-c",
        loopDetection: { enabled: true },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("passes clean calls through unchanged", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "read",
      params: { file_path: "/workspace/README.md" },
      toolCallId: "call-4",
      ctx: {
        agentId: "main",
        sessionKey: "session-d",
        loopDetection: { enabled: true },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("treats require_override rules as blocked at the hook layer", async () => {
    const reqOverride: RationalizationRule = {
      id: "req-override-test",
      category: "process",
      severity: "high",
      pattern: "dangerous thing",
      rebuttal: "Don't do the dangerous thing.",
      action: "require_override",
    };
    __setRationalizationRulesForTest([reqOverride]);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "perform dangerous thing" },
      toolCallId: "call-5",
      ctx: {
        agentId: "main",
        sessionKey: "session-e",
        loopDetection: { enabled: true },
      },
    });
    expect(result.blocked).toBe(true);
  });
});
