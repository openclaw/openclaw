import { expect, it } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import {
  createSessionEntry,
  waitForFast,
  type SubagentRegistryHarness,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";

const identity = (suffix: string) => ({
  sessionId: `session-${suffix}`,
  lifecycleRevision: `revision-${suffix}`,
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
  const fixture = () => {
    const mod = getRegistry();
    const now = Date.now();
    const add = (suffix: string, overrides: Partial<SubagentRunRecordOverrides> = {}) =>
      mod.addSubagentRunForTests({
        runId: `run-${suffix}`,
        childSessionKey: `agent:main:subagent:${suffix}`,
        childSessionIdentity: identity(suffix),
        task: suffix,
        createdAt: now,
        ...overrides,
      });
    const completed = (suffix: string, overrides: Partial<SubagentRunRecordOverrides> = {}) =>
      add(suffix, {
        collect: true,
        collectorCompletion: { status: "done" },
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        ...overrides,
      });
    return { mod, now, add, completed };
  };
  it.each(["session", "agent"])(
    "keeps collector archive groups scoped to their requester %s",
    async (scope) => {
      const { mod, now, completed } = fixture();
      for (const suffix of ["one", "two"]) {
        const requesterSessionKey = scope === "agent" ? "global" : `agent:main:requester-${suffix}`;
        await completed(suffix, {
          childSessionKey: `agent:${suffix}:subagent:collector`,
          requesterSessionKey,
          requesterAgentId: scope === "agent" ? suffix : "main",
          cleanup: "delete",
          cleanupCompletedAt: now - 4_000,
          archiveAtMs: suffix === "one" ? now - 1 : now + 1_000,
          groupId: "swarm:shared-group-id",
        });
      }

      await mod.testing.sweepOnceForTests();

      expect(mod.getSubagentRunByRunId("run-one")).toBeUndefined();
      expect(mod.getSubagentRunByRunId("run-two")).toBeDefined();
    },
  );

  it.each(["sweep", "collector cleanup", "collector replacement"] as const)(
    "revalidates collector ownership after awaited %s work",
    async (phase) => {
      const { mod, now, add, completed } = fixture();
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
        await add("archive-blocker", {
          childSessionKey: blockerKey,
          childSessionIdentity: identity("blocker"),
          cleanup: "delete",
          createdAt: now - 10_000,
          endedAt: now - 5_000,
          cleanupCompletedAt: now - 4_000,
          archiveAtMs: now - 1,
        });
      }
      await completed("collector-before-await", { groupId: "swarm:cleanup-race" });
      const sweep = mod.testing.runSweeperTickForTests();
      await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
      if (phase === "sweep") {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      }
      await add("collector-after-await", {
        collect: true,
        groupId: "swarm:cleanup-race",
        ...(phase === "collector replacement"
          ? {
              runId,
              endedAt: now,
              archiveAtMs: now - 1,
              collectorCompletion: { status: "done" as const },
            }
          : {}),
      });
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
