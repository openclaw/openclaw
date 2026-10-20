import { expect, it, onTestFinished, vi } from "vitest";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { bindSubagentRunGatewayOwners } from "./subagent-registry-gateway-owner.js";
import { getSubagentActivationRuns, subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { persistRegistryFixture } from "./subagent-registry-state.fixture.test-support.js";
import {
  getSubagentSessionListRunsSnapshotForRead as readCompact,
  getSubagentRunsSnapshotForRead as readRuns,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerSubagentRestoreCacheCases(params: {
  createRun: (runId: string, overrides?: Partial<SubagentRunRecord>) => SubagentRunRecord;
  mockRestoredRows(runs: Map<string, SubagentRunRecord>): void;
  refuseNextWrite(): void;
}) {
  const { createRun } = params;
  function observe<T>(registration: { release(): void }, read: () => T) {
    const listener = vi.fn(read);
    const stop = sessionChanges.subscribe(listener);
    onTestFinished(() => {
      stop();
      registration.release();
      subagentRuns.clear();
    });
    return listener;
  }
  it("keeps restored history cold without publishing unchanged session facts", async () => {
    vi.useRealTimers();
    const restored = new Map(
      Array.from({ length: 257 }, (_, index) => {
        const entry = createRun(`retained-${index}`, {
          execution: { status: "terminal", endedAt: 100, outcome: { status: "ok" } },
          cleanupCompletedAt: 100,
          delivery: { status: "not_required" },
        });
        return [entry.runId, entry] as const;
      }),
    );
    params.mockRestoredRows(restored);
    await restoreSubagentRunsFromDisk({ runs: subagentRuns });
    const first = subagentRuns.get("retained-0")!;
    const registration = subagentRuns.captureRegistrationOwnership(first.childSessionKey, first);
    const gateway = { resolveGatewayContext: () => gateway as never };
    const listener = observe(registration, () => {});
    expect(
      await bindSubagentRunGatewayOwners({
        runs: subagentRuns,
        entries: [...getSubagentActivationRuns(subagentRuns)],
        resumedRuns: new Set(),
        getGatewayContextResolver: () => gateway.resolveGatewayContext,
        onRecovered: () => {},
      }),
    ).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(subagentRuns.size).toBe(restored.size);
    for (const entry of subagentRuns.values()) {
      expect(getGatewayContextResolver(entry)).toBeUndefined();
      expect(entry.execution.outcome).toEqual({ status: "ok" });
    }
    expect(() => registration.assertCurrent()).not.toThrow();
  });

  it("publishes restored rows together after replacing ownership and cached facts", async () => {
    subagentRuns.clear();
    const previous = { ...createRun("replaced"), generation: 1 };
    persistRegistryFixture(new Map([[previous.runId, previous]]));
    subagentRuns.set(previous.runId, previous);
    const registration = subagentRuns.captureRegistrationOwnership(
      previous.childSessionKey,
      previous,
    );
    const restored = new Map<string, SubagentRunRecord>([
      [previous.runId, { ...previous, generation: 2 }],
      ["second", createRun("second")],
    ]);
    params.mockRestoredRows(restored);
    const listener = observe(registration, () => ({
      live: [...subagentRuns.keys()],
      cached: [...readCompact(new Map()).keys()],
      superseded: registration.superseded,
    }));
    await restoreSubagentRunsFromDisk({ runs: subagentRuns });
    expect(listener.mock.results).toEqual([
      {
        type: "return",
        value: { live: [...restored.keys()], cached: [...restored.keys()], superseded: true },
      },
    ]);
    expect(registration.assertCurrent).toThrow("owner changed");
  });

  it.each([true, false])(
    "restores canonical rows across an external deletion publication (committed: %s)",
    async (committed) => {
      const entry = createRun("retained");
      const canonical = new Map([[entry.runId, entry]]);
      persistRegistryFixture(canonical);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let reads = 0;
      vi.mocked(stateReads.executeExistingOpenClawStateRead).mockImplementation(
        async (_options, command, options) => {
          expect(command).toEqual({ type: "subagents.restore" });
          const snapshot = structuredClone(canonical);
          if (++reads === 1) {
            entered.resolve();
            await release.promise;
          }
          options?.onChunk?.(
            [...snapshot.values()].map((restored) => ({
              entry: restored,
              createdAt: restored.createdAt,
            })),
          );
          return {
            ok: true,
            type: "subagents.restore",
            sourceAdmitted: true,
            count: snapshot.size,
          };
        },
      );
      const restored = new Map<string, SubagentRunRecord>();
      const restoring = restoreSubagentRunsFromDisk({ runs: restored });
      try {
        await entered.promise;
        if (committed) {
          persistRegistryFixture(new Map(), [entry.runId]);
          canonical.delete(entry.runId);
        } else {
          params.refuseNextWrite();
          expect(() => persistRegistryFixture(new Map(), [entry.runId])).toThrow("write refused");
        }
      } finally {
        release.resolve();
      }
      await restoring;
      expect(restored.has(entry.runId)).toBe(!committed);
      expect(readRuns(new Map()).has(entry.runId)).toBe(!committed);
    },
  );
}
