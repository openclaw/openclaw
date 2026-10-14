import { expect, it } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import {
  createSessionEntry,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import { makeCompletedCollectorRun } from "./subagent-registry.run-fixtures.test-support.js";

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
      for (const [suffix, archiveAtMs] of [
        ["one", now - 1],
        ["two", now + 1_000],
      ] as const) {
        const requesterSessionKey = scope === "agent" ? "global" : `agent:main:requester-${suffix}`;
        await mod.addSubagentRunForTests(
          makeCompletedCollectorRun({
            runId: `run-${suffix}`,
            childSessionKey: `agent:${suffix}:subagent:collector`,
            childSessionIdentity: {
              sessionId: `session-${suffix}`,
              lifecycleRevision: `revision-${suffix}`,
            },
            requesterSessionKey,
            requesterAgentId: scope === "agent" ? suffix : "main",
            task: "retain requester-scoped collector groups",
            cleanup: "delete",
            createdAt: now - 10_000,
            endedAt: now - 5_000,
            cleanupCompletedAt: now - 4_000,
            archiveAtMs,
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
      const blockerIdentity = {
        sessionId: "session-blocker",
        lifecycleRevision: "revision-blocker",
      };
      const collectorIdentity = {
        sessionId: "session-collector-before-await",
        lifecycleRevision: "revision-collector-before-await",
      };
      mocks.entries = {
        [blockerKey]: createSessionEntry({
          ...(phase === "sweep" ? blockerIdentity : collectorIdentity),
        }),
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
          childSessionIdentity: blockerIdentity,
          task: "hold the sweep before collector archival",
          cleanup: "delete",
          createdAt: now - 10_000,
          endedAt: now - 5_000,
          cleanupCompletedAt: now - 4_000,
          archiveAtMs: now - 1,
        });
      }
      await mod.addSubagentRunForTests(
        makeCompletedCollectorRun({
          runId,
          childSessionKey,
          childSessionIdentity: collectorIdentity,
          task: "completed collector present before cleanup",
          createdAt: now - 10_000,
          endedAt: now - 5_000,
          archiveAtMs: now - 1,
          groupId: "swarm:cleanup-race",
        }),
      );
      const sweep = mod.testing.runSweeperTickForTests();
      await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
      if (phase === "sweep") {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      }
      if (phase === "collector replacement") {
        await mod.addSubagentRunForTests(
          makeCompletedCollectorRun({
            runId,
            childSessionKey: "agent:main:subagent:collector-after-await",
            childSessionIdentity: {
              sessionId: "session-collector-after-await",
              lifecycleRevision: "revision-collector-after-await",
            },
            task: "collector after replacement",
            createdAt: now,
            endedAt: now,
            archiveAtMs: now - 1,
            groupId: "swarm:cleanup-race",
          }),
        );
      } else {
        await mod.addSubagentRunForTests({
          runId: "run-collector-after-await",
          childSessionKey: "agent:main:subagent:collector-after-await",
          childSessionIdentity: {
            sessionId: "session-collector-after-await",
            lifecycleRevision: "revision-collector-after-await",
          },
          task: "incomplete collector registered during cleanup",
          createdAt: now,
          collect: true,
          groupId: "swarm:cleanup-race",
        });
      }
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
