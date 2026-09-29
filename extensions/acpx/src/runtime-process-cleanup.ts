/** Capture OpenClaw wrapper cleanup ownership before a backend close can yield. */
import { renderAgentCommand, type AcpxAgentCommand } from "./command-line.js";
import { readAcpxProcessLeaseIdentity, type AcpxProcessLeaseStore } from "./process-lease.js";
import {
  cleanupOpenClawOwnedAcpxPendingLease,
  cleanupOpenClawOwnedAcpxProcessTree,
  type AcpxProcessCleanupDeps,
} from "./process-reaper.js";
import {
  type AcpLoadedSessionRecord,
  readOpenClawGatewayInstanceIdFromRecord,
  readOpenClawLeaseIdFromRecord,
  readRecordAgentPid,
  readSessionRecordName,
  selectCurrentSessionLease,
} from "./runtime-session-store.js";

export async function prepareAcpxProcessCleanup(params: {
  record: AcpLoadedSessionRecord;
  command: AcpxAgentCommand | undefined;
  sessionKey: string;
  gatewayInstanceId?: string;
  wrapperRoot?: string;
  leaseStore?: AcpxProcessLeaseStore;
  deps?: AcpxProcessCleanupDeps;
}): Promise<() => Promise<void>> {
  const { leaseStore, gatewayInstanceId, wrapperRoot, deps } = params;
  // Upstream close may clear the record's PID or replace its command metadata.
  const rootPid = readRecordAgentPid(params.record);
  const rootCommand = params.command ? renderAgentCommand(params.command) : undefined;
  const identity = readAcpxProcessLeaseIdentity(params.command);
  const leaseId = readOpenClawLeaseIdFromRecord(params.record) ?? identity?.leaseId;
  const expectedGatewayInstanceId =
    readOpenClawGatewayInstanceIdFromRecord(params.record) ?? identity?.gatewayInstanceId;
  const sessionKeys = [params.sessionKey, readSessionRecordName(params.record)];
  // A PID can disambiguate a stale saved lease ID. Without one, only the exact
  // saved lease is evidence of ownership; the newest logical lease may be a reset successor.
  const openLeases =
    rootPid && gatewayInstanceId && leaseStore ? await leaseStore.listOpen(gatewayInstanceId) : [];
  const selectedLease = rootPid
    ? selectCurrentSessionLease({ leases: openLeases, sessionKeys, rootPid })
    : undefined;
  const loadedLease = leaseId ? await leaseStore?.load(leaseId) : undefined;
  const ownedLease =
    selectedLease ??
    (loadedLease &&
    loadedLease.gatewayInstanceId === gatewayInstanceId &&
    (!rootPid || loadedLease.rootPid === rootPid) &&
    sessionKeys.includes(loadedLease.sessionKey)
      ? loadedLease
      : undefined);
  // Do not retain a mutable store record across the backend close.
  const lease = ownedLease ? { ...ownedLease } : undefined;

  return async () => {
    if (lease && lease.gatewayInstanceId === gatewayInstanceId) {
      await leaseStore?.markState(lease.leaseId, "closing");
      const result =
        lease.rootPid > 0
          ? await cleanupOpenClawOwnedAcpxProcessTree({
              rootPid: lease.rootPid,
              rootCommand,
              expectedLeaseId: lease.leaseId,
              expectedGatewayInstanceId: lease.gatewayInstanceId,
              wrapperRoot: lease.wrapperRoot,
              deps,
            })
          : await cleanupOpenClawOwnedAcpxPendingLease({
              leaseId: lease.leaseId,
              gatewayInstanceId: lease.gatewayInstanceId,
              wrapperRoot: lease.wrapperRoot,
              wrapperPath: lease.wrapperPath,
              deps,
            });
      await leaseStore?.markState(
        lease.leaseId,
        result.skippedReason === "process-list-unavailable" ||
          result.skippedReason === "unsupported-platform" ||
          (lease.rootPid <= 0 &&
            (result.skippedReason === "ambiguous-root" ||
              result.skippedReason === "unverified-root"))
          ? "open"
          : result.terminatedPids.length > 0 || result.skippedReason === "missing-root"
            ? "closed"
            : "lost",
      );
      return;
    }
    if (!rootPid || !rootCommand) {
      return;
    }
    await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid,
      rootCommand,
      ...(leaseId ? { expectedLeaseId: leaseId } : {}),
      ...(expectedGatewayInstanceId ? { expectedGatewayInstanceId } : {}),
      wrapperRoot,
      deps,
    });
  };
}
