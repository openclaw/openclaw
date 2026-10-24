import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";

type RestoreOptions = Parameters<typeof createSubagentRegistryRestorer>[0];

export function createTestSubagentRegistryRestorer(
  options: Pick<RestoreOptions, "getGatewayContextResolver"> & Partial<RestoreOptions>,
) {
  return createSubagentRegistryRestorer({
    runs: subagentRuns,
    bindGatewayOwners: () => true,
    settleRequesterTurn: async () => false,
    retireSupersededRun: async () => {},
    ensureListener: () => {},
    startSweeper: () => {},
    scheduleSweep: () => {},
    recoverInterruptedRuns: async () => {},
    resumeRun: () => {},
    listSwarmRunsForGroup: () => [],
    startQueuedSubagentRun: async () => true,
    terminateAcceptedRestoredCollectorRun: async () => {},
    cleanupCollectorLaunchResources: async () => true,
    settleFailedQueuedSubagentLaunch: async () => true,
    completeCollectorLaunchCleanup: async () => {},
    warn: subagentRegistryLog.warn,
    ...options,
  });
}
