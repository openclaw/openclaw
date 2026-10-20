import { expect, it, onTestFinished, vi } from "vitest";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../../sessions/session-lifecycle-events.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { persistRegistryFixture } from "./subagent-registry-state.fixture.test-support.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerSubagentCollectorPublicationCases(params: {
  createRun: (runId: string, overrides?: Partial<SubagentRunRecord>) => SubagentRunRecord;
  mockRestoredRows(runs: Map<string, SubagentRunRecord>): void;
}) {
  const { createRun } = params;
  const parent = { sessionKey: "global", agentId: "ops", reason: "swarm", scope: "runtime" };
  const collector = (id: string, overrides: Partial<SubagentRunRecord> = {}) =>
    createRun(id, {
      collect: true,
      swarmRequesterSessionKey: "global",
      requesterAgentId: "ops",
      groupId: "opaque-group",
      ...overrides,
    });
  it("invalidates the strict collector parent after each committed lifecycle transition", async () => {
    const run = collector("cross-agent", {
      childSessionKey: "agent:research:subagent:child",
      execution: { status: "queued" },
    });
    const runs = new Map([[run.runId, run]]);
    params.mockRestoredRows(new Map());
    await restoreSubagentRunsFromDisk({ runs: new Map() });
    const observed: Array<{ event: SessionLifecycleEvent; stored?: SubagentRunRecord }> = [];
    onTestFinished(
      onSessionLifecycleEvent((event) => {
        observed.push({ event, stored: getSubagentRunsSnapshotForRead(new Map()).get(run.runId) });
      }),
    );
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
    expect(observed.map(({ event }) => event)).toEqual(Array.from({ length: 4 }, () => parent));
    expect(
      observed.map(({ stored }) => stored?.collectorCompletion?.status ?? stored?.execution.status),
    ).toEqual(["queued", "running", "done", undefined]);
  });

  it("invalidates archived cold-restored groups once per exact parent", async () => {
    const rows = ["a", "b"].map((id) => collector(id, { collectorCompletion: { status: "done" } }));
    params.mockRestoredRows(new Map(rows.map((row) => [row.runId, row])));
    const runs = new Map<string, SubagentRunRecord>();
    const received = vi.fn();
    onTestFinished(onSessionLifecycleEvent(received));
    await restoreSubagentRunsFromDisk({ runs });
    expect(received).not.toHaveBeenCalled();
    runs.clear();
    persistRegistryFixture(
      runs,
      rows.map((row) => row.runId),
    );
    expect(received).toHaveBeenCalledExactlyOnceWith(parent);
  });

  it("does not infer collector parent ownership from requester or group strings", () => {
    const base = { ...createRun("missing"), collect: true, groupId: "swarm:agent:ops:parent:run" };
    const rows: SubagentRunRecord[] = [
      base,
      { ...base, runId: "no-agent", swarmRequesterSessionKey: "agent:ops:parent" },
      { ...base, runId: "no-key", requesterAgentId: "ops" },
      collector("ordinary", { collect: false }),
    ];
    const received = vi.fn();
    onTestFinished(onSessionLifecycleEvent(received));
    persistRegistryFixture(
      new Map(rows.map((row) => [row.runId, row])),
      rows.map((row) => row.runId),
    );
    expect(received).not.toHaveBeenCalled();
  });
}
