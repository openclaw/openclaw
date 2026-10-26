import { afterEach, expect, it } from "vitest";
import { registerAgentRunCapacityWait } from "../../../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  getAgentRunLifecycleGeneration,
  releaseAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  observeSubagentExecution,
  resolveYieldedLeafPausedForMs,
} from "./subagent-execution-observation.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function run(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    generation: 1,
    ...overrides,
  });
}

afterEach(() => subagentRuns.clear());

it("reports capacity-waiting subagents as queued", () => {
  const entry = run("capacity-waiting-child", { collect: true });
  subagentRuns.set(entry.runId, entry);
  const claim = claimAgentRunContext(
    entry.runId,
    { sessionKey: entry.childSessionKey },
    { trackOwner: true, ownsContext: true },
  );
  const releaseWait = registerAgentRunCapacityWait(entry.runId, getAgentRunLifecycleGeneration());
  try {
    expect(observeSubagentExecution(entry, [])).toEqual({ state: "queued" });
    releaseWait?.();
    expect(observeSubagentExecution(entry, [])).toEqual({ state: "running" });
  } finally {
    releaseWait?.();
    releaseAgentRunContext(entry.runId, claim);
  }
  expect(observeSubagentExecution(entry, [])).toEqual({ state: "unknown" });
});

it("observes only latest announced children and clears dependencies after settlement or deletion", () => {
  const parent = run("parent", {
    pauseReason: "sessions_yield",
    execution: { status: "terminal", endedAt: Date.now() },
  });
  const wait = () => observeSubagentExecution(parent, subagentRuns.values()).wait;
  subagentRuns.set(parent.runId, parent);
  const child = run("child", {
    requesterSessionKey: parent.childSessionKey,
    expectsCompletionMessage: true,
  });
  const collector = run("collector", {
    requesterSessionKey: parent.childSessionKey,
    collect: true,
  });
  subagentRuns.set(child.runId, child);
  subagentRuns.set(collector.runId, collector);
  expect(wait()).toEqual({
    kind: "children",
    pendingCount: 1,
    dependencies: [{ runId: child.runId, sessionKey: child.childSessionKey }],
  });
  const replacement = run("replacement", {
    childSessionKey: child.childSessionKey,
    requesterSessionKey: parent.childSessionKey,
    generation: 2,
    expectsCompletionMessage: true,
    execution: { status: "terminal", endedAt: Date.now() },
    cleanupCompletedAt: Date.now(),
  });
  subagentRuns.set(replacement.runId, replacement);
  expect(wait()).toEqual({ kind: "external" });
  replacement.pauseReason = "sessions_yield";
  replacement.endedReason = "subagent-killed";
  replacement.execution.outcome = { status: "error", error: "killed" };
  expect(wait()).toEqual({ kind: "external" });
  replacement.cleanupCompletedAt = undefined;
  expect(wait()).toMatchObject({
    kind: "children",
    pendingCount: 1,
  });
  subagentRuns.delete(child.runId);
  subagentRuns.delete(replacement.runId);
  expect(wait()).toEqual({ kind: "external" });
});

it("reports pause age only for a continuable yielded leaf", () => {
  const now = 2_000_000_000_000;
  const pausedAt = now - 90_000_000;
  const age = (overrides: Partial<SubagentRunRecord> = {}) => {
    const entry = run("paused", {
      pauseReason: "sessions_yield",
      execution: { status: "terminal", endedAt: pausedAt },
      ...overrides,
    });
    return resolveYieldedLeafPausedForMs(entry, observeSubagentExecution(entry, []), now);
  };

  expect(age({ execution: { status: "terminal", endedAt: now + 5 } })).toBe(0);
  expect(age({ collect: true })).toBeUndefined();
  expect(
    age({ execution: { status: "running", startedAt: pausedAt, endedAt: pausedAt } }),
  ).toBeUndefined();
  expect(age({ pauseReason: undefined })).toBeUndefined();
  expect(age({ execution: { status: "terminal" } })).toBeUndefined();
});
