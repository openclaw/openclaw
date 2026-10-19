export * from "./subagent-registry.js";
export {
  buildSubagentSessionListReadIndex,
  countPendingDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
  getLatestSubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  isSubagentRunLive,
  isSubagentSessionRunActive,
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  resolveSubagentSessionStatus,
  shouldIgnorePostCompletionAnnounceForSession,
} from "./subagent-registry-read.js";

import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { immutableSubagentRun, subagentRuns } from "./subagent-registry-memory.js";
import { getSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForChildSession } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export async function getSubagentRunByChildSessionKey(
  childSessionKey: string,
  childAgentId?: string,
): Promise<SubagentRunRecord | null> {
  const runs = await getSubagentRunsSnapshotForChildSession(
    subagentRuns,
    childSessionKey,
    childAgentId,
  );
  return getSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey, childAgentId);
}

type RegistryTestApi = {
  releaseSubagentRun(runId: string): Promise<void>;
  resetSubagentRegistryForTests(opts?: { persist?: boolean }): Promise<void>;
  testing: {
    sweepOnceForTests(): Promise<void>;
    runSweeperTickForTests(): Promise<void>;
  };
};

function getRegistryTestApi(): RegistryTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentRegistryTestApi")
  ] as RegistryTestApi;
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  return getRegistryTestApi().resetSubagentRegistryForTests(opts);
}

function createRegistryRunFixture(entry: SubagentRunRecordOverrides): SubagentRunRecord {
  const canonical = createSubagentRunRecord(entry);
  const requesterAgentId =
    entry.requesterAgentId ?? parseAgentSessionKey(canonical.requesterSessionKey)?.agentId;
  if (!Object.hasOwn(entry, "requesterStorePath") && requesterAgentId) {
    canonical.requesterStorePath = resolvePhysicalSessionStorePath({
      sessionKey: canonical.requesterSessionKey,
      agentId: requesterAgentId,
    });
  }
  const controllerKey = canonical.controllerSessionKey ?? canonical.requesterSessionKey;
  const controllerAgentId = parseAgentSessionKey(controllerKey)?.agentId ?? requesterAgentId;
  if (!Object.hasOwn(entry, "controllerStorePath") && controllerAgentId) {
    canonical.controllerStorePath = resolvePhysicalSessionStorePath({
      sessionKey: controllerKey,
      agentId: controllerAgentId,
    });
  }
  return canonical;
}

export async function addSubagentRunForTests(entry: SubagentRunRecordOverrides) {
  const canonical = createRegistryRunFixture(entry);
  const { mutateSubagentRuns } = await import("./subagent-registry-persistence.js");
  await mutateSubagentRuns([canonical.runId], () => ({
    value: undefined,
    postimages: new Map([[canonical.runId, canonical]]),
  }));
}

/** Read-only fixtures install canonical immutable rows without durable write admission. */
export function seedSubagentRunForReadTest(entry: SubagentRunRecordOverrides): void {
  const canonical = immutableSubagentRun(structuredClone(createRegistryRunFixture(entry)));
  subagentRuns.set(canonical.runId, canonical);
}

export function releaseSubagentRun(runId: string) {
  return getRegistryTestApi().releaseSubagentRun(runId);
}

export async function finalizeInterruptedSubagentRun(params: {
  runId: string;
  expectedEntry?: SubagentRunRecord;
  error: string;
  endedAt?: number;
}) {
  const registry = await import("./subagent-registry.js");
  return await registry.finalizeInterruptedSubagentRun(params);
}

export const testing = {
  sweepOnceForTests: () => getRegistryTestApi().testing.sweepOnceForTests(),
  runSweeperTickForTests: () => getRegistryTestApi().testing.runSweeperTickForTests(),
};
