import { expect, it, vi } from "vitest";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../../sessions/session-lifecycle-events.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { persistRegistryFixture } from "./subagent-registry-state.fixture.test-support.js";
import {
  getSubagentRunsSnapshotForRead,
  publishSubagentRunsAfterAtomicStore,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerSubagentCollectorPublicationCases(params: {
  createRun: (runId: string) => SubagentRunRecord;
  mockRestoredRows(runs: Map<string, SubagentRunRecord>): void;
  refuseNextWrite(): void;
}) {
  const { createRun } = params;
  it("invalidates the strict collector parent after each committed lifecycle transition", () => {
    const run: SubagentRunRecord = {
      ...createRun("cross-agent"),
      childSessionKey: "agent:research:subagent:child",
      collect: true,
      swarmRequesterSessionKey: "global",
      requesterAgentId: "ops",
      groupId: "opaque-group",
      execution: { status: "queued" as const },
    };
    const runs = new Map([[run.runId, run]]);
    params.mockRestoredRows(new Map());
    getSubagentRunsSnapshotForRead(new Map());
    const observed: Array<{ event: SessionLifecycleEvent; stored?: SubagentRunRecord }> = [];
    const unsubscribe = onSessionLifecycleEvent((event) => {
      observed.push({ event, stored: getSubagentRunsSnapshotForRead(new Map()).get(run.runId) });
    });
    try {
      persistRegistryFixture(runs, [run.runId]);
      run.execution = { status: "running", startedAt: 2 };
      persistRegistryFixture(runs, [run.runId]);
      run.execution = { status: "terminal", endedAt: 3, outcome: { status: "ok" } };
      run.collectorCompletion = { status: "done", structured: { private: "child result" } };
      persistRegistryFixture(runs, [run.runId]);
      run.task = "unrelated bookkeeping";
      persistRegistryFixture(runs, [run.runId]);
      runs.delete(run.runId);
      persistRegistryFixture(runs, [run.runId]);
      expect(observed.map(({ event }) => event)).toEqual(
        Array.from({ length: 4 }, () => ({
          sessionKey: "global",
          agentId: "ops",
          reason: "swarm",
          scope: "runtime",
        })),
      );
      expect(
        observed.map(
          ({ stored }) => stored?.collectorCompletion?.status ?? stored?.execution.status,
        ),
      ).toEqual(["queued", "running", "done", undefined]);
    } finally {
      unsubscribe();
    }
  });

  it("does not advance collector notifications on failed writes", () => {
    const run: SubagentRunRecord = {
      ...createRun("retry"),
      collect: true,
      swarmRequesterSessionKey: "agent:ops:parent",
      requesterAgentId: "ops",
      groupId: "batch",
    };
    const runs = new Map([[run.runId, run]]);
    persistRegistryFixture(runs, [run.runId]);
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      run.collectorCompletion = { status: "failed" };
      params.refuseNextWrite();
      expect(() => persistRegistryFixture(runs, [run.runId])).toThrow("disk unavailable");
      expect(received).not.toHaveBeenCalled();
      persistRegistryFixture(runs, [run.runId]);
      expect(received).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "agent:ops:parent",
        agentId: "ops",
        reason: "swarm",
        scope: "runtime",
      });
    } finally {
      unsubscribe();
    }
  });

  it("invalidates archived cold-restored groups once per exact parent", async () => {
    const rows = ["a", "b"].map((runId) => {
      const run = createRun(runId);
      run.collect = true;
      run.swarmRequesterSessionKey = "global";
      run.requesterAgentId = "ops";
      run.groupId = "batch";
      run.collectorCompletion = { status: "done" };
      return run;
    });
    params.mockRestoredRows(new Map(rows.map((row) => [row.runId, row])));
    const runs = new Map<string, SubagentRunRecord>();
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      await restoreSubagentRunsFromDisk({ runs });
      expect(received).not.toHaveBeenCalled();
      runs.clear();
      persistRegistryFixture(
        runs,
        rows.map((row) => row.runId),
      );
      expect(received).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "global",
        agentId: "ops",
        reason: "swarm",
        scope: "runtime",
      });
    } finally {
      unsubscribe();
    }
  });

  it("defers atomic collector notifications until all owner snapshots are published", () => {
    const run: SubagentRunRecord = {
      ...createRun("atomic"),
      collect: true,
      swarmRequesterSessionKey: "agent:ops:parent",
      requesterAgentId: "ops",
      groupId: "batch",
    };
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      const deferred: Array<() => void> = [];
      params.mockRestoredRows(new Map());
      getSubagentRunsSnapshotForRead(new Map());
      publishSubagentRunsAfterAtomicStore(new Map([[run.runId, run]]), [run.runId], deferred);
      expect(received).not.toHaveBeenCalled();
      expect(getSubagentRunsSnapshotForRead(new Map()).get(run.runId)?.groupId).toBe("batch");
      for (const publish of deferred) {
        publish();
      }
      expect(received).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "agent:ops:parent",
        agentId: "ops",
        reason: "swarm",
        scope: "runtime",
      });
    } finally {
      unsubscribe();
    }
  });

  it("does not infer collector parent ownership from requester or group strings", () => {
    const base = { ...createRun("missing"), collect: true, groupId: "swarm:agent:ops:parent:run" };
    const rows: SubagentRunRecord[] = [
      base,
      { ...base, runId: "no-agent", swarmRequesterSessionKey: "agent:ops:parent" },
      { ...base, runId: "no-key", requesterAgentId: "ops" },
      {
        ...base,
        runId: "ordinary",
        collect: false,
        swarmRequesterSessionKey: "agent:ops:parent",
        requesterAgentId: "ops",
      },
    ];
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      persistRegistryFixture(
        new Map(rows.map((row) => [row.runId, row])),
        rows.map((row) => row.runId),
      );
      expect(received).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
}
