/**
 * Plan-mode debug log helper — opt-in gate + structured event coverage.
 *
 * Three contracts under test:
 * 1. The env-var gate (`OPENCLAW_DEBUG_PLAN_MODE=1`) is honored on
 *    every call — no global cache, so late-set/late-cleared env vars
 *    take effect immediately.
 * 2. The config-flag gate (`agents.defaults.planMode.debug: true`) is
 *    also honored — added in iter-2 Bug D because the env-var path
 *    doesn't reliably propagate to gateway processes supervised by
 *    the OpenClaw Mac app.
 * 3. Each event `kind` serializes with the expected metadata fields
 *    so future grep'ing on `[plan-mode/<kind>]` lines yields stable
 *    structured data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const debugMock = vi.fn();
const loadConfigMock = vi.fn(() => ({}) as Record<string, unknown>);

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    subsystem: "plan-mode",
    isEnabled: vi.fn(() => true),
    trace: vi.fn(),
    debug: debugMock,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  })),
}));

vi.mock("../../config/io.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

const { logPlanModeDebug, _resetIsPlanModeDebugEnabledCacheForTests } =
  await import("./plan-mode-debug-log.js");

describe("logPlanModeDebug — env-var gate", () => {
  beforeEach(() => {
    debugMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("no-op when OPENCLAW_DEBUG_PLAN_MODE unset", () => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "");
    logPlanModeDebug({
      kind: "state_transition",
      sessionKey: "session-1",
      from: "plan",
      to: "normal",
      trigger: "user_approval",
    });
    expect(debugMock).not.toHaveBeenCalled();
  });

  it("no-op when OPENCLAW_DEBUG_PLAN_MODE set to value other than '1'", () => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "true");
    logPlanModeDebug({
      kind: "state_transition",
      sessionKey: "session-1",
      from: "plan",
      to: "normal",
      trigger: "user_approval",
    });
    expect(debugMock).not.toHaveBeenCalled();
  });

  it("emits when OPENCLAW_DEBUG_PLAN_MODE=1", () => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "1");
    logPlanModeDebug({
      kind: "state_transition",
      sessionKey: "session-1",
      from: "plan",
      to: "normal",
      trigger: "user_approval",
    });
    expect(debugMock).toHaveBeenCalledTimes(1);
  });

  it("respects late-set env var (no cached gate)", () => {
    // Disabled at first call.
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "");
    logPlanModeDebug({
      kind: "gate_decision",
      sessionKey: "session-1",
      tool: "edit",
      allowed: false,
      planMode: "plan",
    });
    expect(debugMock).toHaveBeenCalledTimes(0);

    // Enabled mid-process — next call SHOULD fire.
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "1");
    logPlanModeDebug({
      kind: "gate_decision",
      sessionKey: "session-1",
      tool: "edit",
      allowed: false,
      planMode: "plan",
    });
    expect(debugMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Live-test iter-2 Bug D: config-flag activation. Env-var path is
 * unreliable on macOS when the gateway is supervised by the Mac app
 * (launchd setenv only affects future launchd-spawned processes).
 * The config-flag path reads `agents.defaults.planMode.debug` from
 * disk on every call so the user can toggle it via
 * `openclaw config set agents.defaults.planMode.debug true` and a
 * gateway restart picks it up reliably.
 */
describe("logPlanModeDebug — config-flag gate (Bug D iter-2)", () => {
  beforeEach(() => {
    debugMock.mockReset();
    loadConfigMock.mockReset();
    // Default: env unset so config flag is the only signal.
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "");
    // Reset the 30s TTL cache (post-nuclear-fix-stack perf fix at
    // plan-mode-debug-log.ts:160) so tests that mock different
    // config values aren't blocked by a stale cached value from a
    // prior test in the same suite.
    _resetIsPlanModeDebugEnabledCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits when agents.defaults.planMode.debug=true", () => {
    loadConfigMock.mockReturnValue({
      agents: { defaults: { planMode: { debug: true } } },
    });
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
    });
    expect(debugMock).toHaveBeenCalledTimes(1);
  });

  it("no-op when agents.defaults.planMode.debug=false", () => {
    loadConfigMock.mockReturnValue({
      agents: { defaults: { planMode: { debug: false } } },
    });
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
    });
    expect(debugMock).not.toHaveBeenCalled();
  });

  it("no-op when planMode config block is missing", () => {
    loadConfigMock.mockReturnValue({});
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
    });
    expect(debugMock).not.toHaveBeenCalled();
  });

  it("no-op when loadConfig throws (fail-closed)", () => {
    loadConfigMock.mockImplementation(() => {
      throw new Error("config corrupt");
    });
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
    });
    expect(debugMock).not.toHaveBeenCalled();
  });

  it("env var WINS over config flag (env=1, config=false → emit)", () => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "1");
    loadConfigMock.mockReturnValue({
      agents: { defaults: { planMode: { debug: false } } },
    });
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
    });
    expect(debugMock).toHaveBeenCalledTimes(1);
  });
});

describe("logPlanModeDebug — event-kind serialization", () => {
  beforeEach(() => {
    debugMock.mockReset();
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("state_transition: tag includes kind, meta omits kind", () => {
    logPlanModeDebug({
      kind: "state_transition",
      sessionKey: "s1",
      from: "normal",
      to: "plan",
      trigger: "enter_plan_mode_tool",
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/state_transition]", {
      sessionKey: "s1",
      from: "normal",
      to: "plan",
      trigger: "enter_plan_mode_tool",
    });
  });

  it("gate_decision: includes allowed + planMode + optional reason", () => {
    logPlanModeDebug({
      kind: "gate_decision",
      sessionKey: "s1",
      tool: "exec",
      allowed: false,
      planMode: "plan",
      reason: "mutating tool blocked",
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/gate_decision]", {
      sessionKey: "s1",
      tool: "exec",
      allowed: false,
      planMode: "plan",
      reason: "mutating tool blocked",
    });
  });

  it("tool_call: includes tool name + runId + details", () => {
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: "s1",
      tool: "exit_plan_mode",
      runId: "run-abc",
      details: { stepCount: 5, title: "test" },
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/tool_call]", {
      sessionKey: "s1",
      tool: "exit_plan_mode",
      runId: "run-abc",
      details: { stepCount: 5, title: "test" },
    });
  });

  it("synthetic_injection: includes tag + preview", () => {
    logPlanModeDebug({
      kind: "synthetic_injection",
      sessionKey: "s1",
      tag: "[PLAN_DECISION]",
      preview: "approved",
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/synthetic_injection]", {
      sessionKey: "s1",
      tag: "[PLAN_DECISION]",
      preview: "approved",
    });
  });

  it("nudge_event: includes nudge id + phase", () => {
    logPlanModeDebug({
      kind: "nudge_event",
      sessionKey: "s1",
      nudgeId: "nudge-1",
      phase: "scheduled",
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/nudge_event]", {
      sessionKey: "s1",
      nudgeId: "nudge-1",
      phase: "scheduled",
    });
  });

  it("subagent_event: includes parent + child runIds + event", () => {
    logPlanModeDebug({
      kind: "subagent_event",
      sessionKey: "s1",
      parentRunId: "run-parent",
      childRunId: "run-child",
      event: "spawn",
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/subagent_event]", {
      sessionKey: "s1",
      parentRunId: "run-parent",
      childRunId: "run-child",
      event: "spawn",
    });
  });

  it("approval_event: includes action + subagent count + result", () => {
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 2,
      result: "rejected_by_subagent_gate",
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/approval_event]", {
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 2,
      result: "rejected_by_subagent_gate",
    });
  });

  // C7 (Plan Mode 1.0 follow-up): correlation fields.
  it("approval_event: threads approvalRunId + approvalId when present for cross-event correlation", () => {
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
      approvalRunId: "run-abc",
      approvalId: "approval-v1",
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/approval_event]", {
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
      approvalRunId: "run-abc",
      approvalId: "approval-v1",
    });
  });

  it("synthetic_injection: accepts approvalRunId + approvalId for cycle correlation", () => {
    logPlanModeDebug({
      kind: "synthetic_injection",
      sessionKey: "s1",
      tag: "[PLAN_DECISION]",
      preview: "approved",
      approvalRunId: "run-abc",
      approvalId: "approval-v1",
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/synthetic_injection]", {
      sessionKey: "s1",
      tag: "[PLAN_DECISION]",
      preview: "approved",
      approvalRunId: "run-abc",
      approvalId: "approval-v1",
    });
  });

  it("toast_event: includes toast id + phase", () => {
    logPlanModeDebug({
      kind: "toast_event",
      sessionKey: "s1",
      toast: "subagentBlocking",
      phase: "fired",
    });
    expect(debugMock).toHaveBeenCalledWith("[plan-mode/toast_event]", {
      sessionKey: "s1",
      toast: "subagentBlocking",
      phase: "fired",
    });
  });
});
