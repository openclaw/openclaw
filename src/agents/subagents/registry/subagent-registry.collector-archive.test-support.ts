import { expect, it } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import {
  createSessionEntry,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import { makeCompletedCollectorRun } from "./subagent-registry.run-fixtures.test-support.js";

const identity = (suffix: string) => ({
  sessionId: `session-${suffix}`,
  lifecycleRevision: `revision-${suffix}`,
});
const collectorRun = (
  suffix: string,
  now: number,
  overrides: Partial<Parameters<typeof makeCompletedCollectorRun>[0]> = {},
) =>
  makeCompletedCollectorRun({
    runId: `run-${suffix}`,
    childSessionKey: `agent:main:subagent:${suffix}`,
    childSessionIdentity: identity(suffix),
    task: suffix,
    createdAt: now - 10_000,
    endedAt: now - 5_000,
    archiveAtMs: now - 1,
    ...overrides,
  });

export function registerCollectorArchiveTests({
  getRegistry,
  mocks,
}: {
  getRegistry: () => Pick<
    SubagentRegistryHarness,
    "addSubagentRunForTests" | "getSubagentRunByRunId" | "testing"
  >;
  mocks: Pick<ReturnType<typeof createSubagentRegistryMockState>, "entries" | "callGateway">;
}): void {
  it.each(["session", "agent"])(
    "keeps collector archive groups scoped to their requester %s",
    async (scope) => {
      const mod = getRegistry();
      const now = Date.now();
      for (const suffix of ["one", "two"]) {
        const requesterSessionKey = scope === "agent" ? "global" : `agent:main:requester-${suffix}`;
        await mod.addSubagentRunForTests(
          collectorRun(suffix, now, {
            childSessionKey: `agent:${suffix}:subagent:collector`,
            requesterSessionKey,
            requesterAgentId: scope === "agent" ? suffix : "main",
            cleanup: "delete",
            cleanupCompletedAt: now - 4_000,
            archiveAtMs: suffix === "one" ? now - 1 : now + 1_000,
            groupId: "swarm:shared-group-id",
          }),
        );
      }

      await mod.testing.sweepOnceForTests();

      expect(mod.getSubagentRunByRunId("run-one")).toBeUndefined();
      expect(mod.getSubagentRunByRunId("run-two")).toBeDefined();
    },
  );

  it.each(["sweep", "collector cleanup", "collector replacement"] as const)(
    "revalidates collector ownership after awaited %s work",
    async (phase) => {
      const mod = getRegistry();
      const now = Date.now();
      const runId = "run-collector-before-await";
      const childSessionKey = "agent:main:subagent:collector-before-await";
      const blockerKey =
        phase === "sweep" ? "agent:main:subagent:archive-blocker" : childSessionKey;
      mocks.entries = {
        [blockerKey]: createSessionEntry(
          identity(phase === "sweep" ? "blocker" : "collector-before-await"),
        ),
      };
      let releaseDelete: (() => void) | undefined;
      mocks.callGateway.mockImplementation((request: { method?: string }) => {
        if (request.method !== "sessions.delete" || releaseDelete) {
          return Promise.resolve({});
        }
        return new Promise<Record<string, unknown>>((resolve) => {
          releaseDelete = () => resolve({});
        });
      });
      if (phase === "sweep") {
        await mod.addSubagentRunForTests({
          runId: "run-archive-blocker",
          childSessionKey: blockerKey,
          childSessionIdentity: identity("blocker"),
          task: "hold the sweep before collector archival",
          cleanup: "delete",
          createdAt: now - 10_000,
          endedAt: now - 5_000,
          cleanupCompletedAt: now - 4_000,
          archiveAtMs: now - 1,
        });
      }
      await mod.addSubagentRunForTests(
        collectorRun("collector-before-await", now, {
          groupId: "swarm:cleanup-race",
        }),
      );
      const sweep = mod.testing.runSweeperTickForTests();
      await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
      if (phase === "sweep") {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      }
      const after = {
        runId: "run-collector-after-await",
        childSessionKey: "agent:main:subagent:collector-after-await",
        childSessionIdentity: identity("collector-after-await"),
        task: "collector-after-await",
        createdAt: now,
        collect: true,
        groupId: "swarm:cleanup-race",
      };
      await mod.addSubagentRunForTests(
        phase === "collector replacement"
          ? makeCompletedCollectorRun({ ...after, runId, endedAt: now, archiveAtMs: now - 1 })
          : after,
      );
      releaseDelete?.();
      await sweep;
      if (phase === "sweep") {
        await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      }
      if (phase === "collector replacement") {
        expect(mod.getSubagentRunByRunId(runId)?.childSessionKey).toBe(
          "agent:main:subagent:collector-after-await",
        );
      } else {
        expect(mod.getSubagentRunByRunId(runId)).toBeDefined();
        expect(mod.getSubagentRunByRunId("run-collector-after-await")).toBeDefined();
      }
    },
  );
}
