export * from "./subagent-registry.js";
export {
  buildSubagentSessionListReadIndex,
  countActiveDescendantRuns,
  countPendingDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
  getLatestSubagentRunByChildSessionKey,
  getSubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  hasDescendantRunAwaitingSettle,
  isSubagentRunLive,
  isSubagentSessionRunActive,
  listDescendantRunsForRequester,
  listSubagentRunsForController,
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  resolveSubagentSessionStatus,
  shouldIgnorePostCompletionAnnounceForSession,
} from "./subagent-registry-read.js";

import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import { collectSessionMaintenancePreserveKeys } from "../../../config/sessions/store-maintenance-preserve.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RegistryTestApi = {
  addSubagentRunForTests(entry: SubagentRunRecord): void;
  finalizeInterruptedSubagentRun(params: {
    runId: string;
    expectedEntry?: SubagentRunRecord;
    error: string;
    endedAt?: number;
    suppressSessionEffects?: boolean;
  }): Promise<number>;
  releaseSubagentRun(runId: string): void;
  resetSubagentRegistryForTests(opts?: { persist?: boolean }): void;
  testing: {
    failQueuedSubagentRun(runId: string, error: string): boolean;
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
  getRegistryTestApi().resetSubagentRegistryForTests(opts);
}

export function addSubagentRunForTests(entry: SubagentRunRecordOverrides) {
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
  const target = entry as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, canonical);
  getRegistryTestApi().addSubagentRunForTests(entry as SubagentRunRecord);
}

export function releaseSubagentRun(runId: string) {
  getRegistryTestApi().releaseSubagentRun(runId);
}

export async function finalizeInterruptedSubagentRun(params: {
  runId: string;
  expectedEntry?: SubagentRunRecord;
  error: string;
  endedAt?: number;
}) {
  return await getRegistryTestApi().finalizeInterruptedSubagentRun(params);
}

export const testing = {
  failQueuedSubagentRun: (runId: string, error: string) =>
    getRegistryTestApi().testing.failQueuedSubagentRun(runId, error),
  sweepOnceForTests: () => getRegistryTestApi().testing.sweepOnceForTests(),
  runSweeperTickForTests: () => getRegistryTestApi().testing.runSweeperTickForTests(),
};

export function listSessionMaintenanceProtectedSubagentSessionKeys() {
  return [...(collectSessionMaintenancePreserveKeys() ?? [])];
}
