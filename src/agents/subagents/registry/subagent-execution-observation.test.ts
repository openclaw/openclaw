import { afterEach, describe, expect, it } from "vitest";
import { registerAgentRunCapacityWait } from "../../../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  getAgentRunLifecycleGeneration,
  releaseAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import {
  observeSubagentExecution,
  resolveYieldedLeafPausedForMs,
} from "./subagent-execution-observation.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function run(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: runId,
    createdAt: Date.now(),
    cleanup: "keep",
    generation: 1,
    execution: { status: "running", startedAt: Date.now() },
    ...overrides,
  };
}

afterEach(() => subagentRuns.clear());

describe("subagent execution observation", () => {
  it.each([false, true])(
    "reports capacity-waiting subagents as queued (collector=%s)",
    (collect) => {
      const entry = run("capacity-waiting-child", { collect });
      subagentRuns.set(entry.runId, entry);
      const claim = claimAgentRunContext(
        entry.runId,
        { sessionKey: entry.childSessionKey },
        { trackOwner: true, ownsContext: true },
      );
      const releaseWait = registerAgentRunCapacityWait(
        entry.runId,
        getAgentRunLifecycleGeneration(),
      );
      try {
        expect(observeSubagentExecution(entry, [])).toEqual({
          state: "queued",
        });
        releaseWait?.();
        expect(observeSubagentExecution(entry, [])).toEqual({
          state: "running",
        });
      } finally {
        releaseWait?.();
        releaseAgentRunContext(entry.runId, claim);
      }
      expect(observeSubagentExecution(entry, [])).toEqual({
        state: "unknown",
      });
    },
  );

  it("observes only latest announced children and clears dependencies after settlement or deletion", () => {
    const parent = run("parent", {
      pauseReason: "sessions_yield",
      execution: { status: "terminal", endedAt: Date.now() },
    });
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
    expect(observeSubagentExecution(parent, subagentRuns.values()).wait).toEqual({
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
    expect(observeSubagentExecution(parent, subagentRuns.values()).wait).toEqual({
      kind: "external",
    });
    replacement.pauseReason = "sessions_yield";
    replacement.endedReason = "subagent-killed";
    replacement.execution.outcome = { status: "error", error: "killed" };
    expect(observeSubagentExecution(parent, subagentRuns.values()).wait).toEqual({
      kind: "external",
    });
    replacement.cleanupCompletedAt = undefined;
    expect(observeSubagentExecution(parent, subagentRuns.values()).wait).toMatchObject({
      kind: "children",
      pendingCount: 1,
    });
    subagentRuns.delete(child.runId);
    subagentRuns.delete(replacement.runId);
    expect(observeSubagentExecution(parent, subagentRuns.values()).wait).toEqual({
      kind: "external",
    });
  });

  it("reports pause age only for a continuable yielded leaf", () => {
    const now = 2_000_000_000_000;
    const pausedAt = now - 90_000_000;
    const paused = (id: string, overrides: Partial<SubagentRunRecord> = {}) =>
      run(id, {
        pauseReason: "sessions_yield",
        execution: { status: "terminal", endedAt: pausedAt },
        ...overrides,
      });
    const age = (entry: SubagentRunRecord, children: SubagentRunRecord[] = []) =>
      resolveYieldedLeafPausedForMs(entry, observeSubagentExecution(entry, children), now);

    expect(age(paused("leaf"))).toBe(90_000_000);
    expect(age(paused("future", { execution: { status: "terminal", endedAt: now + 5 } }))).toBe(0);

    const parent = paused("parent");
    const child = run("child", {
      requesterSessionKey: parent.childSessionKey,
      expectsCompletionMessage: true,
    });
    expect(age(parent, [child])).toBeUndefined();
    expect(age(paused("collector", { collect: true }))).toBeUndefined();
    expect(age(run("running"))).toBeUndefined();
    expect(
      age(
        paused("resumed", {
          execution: { status: "running", startedAt: pausedAt, endedAt: pausedAt },
        }),
      ),
    ).toBeUndefined();
    expect(
      age(run("finished", { execution: { status: "terminal", endedAt: pausedAt } })),
    ).toBeUndefined();
    expect(age(paused("killed", { endedReason: "subagent-killed" }))).toBeUndefined();
    expect(age(paused("no-timestamp", { execution: { status: "terminal" } }))).toBeUndefined();
  });
});
