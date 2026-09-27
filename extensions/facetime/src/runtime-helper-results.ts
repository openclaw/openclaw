import {
  readHelperResults,
  type FaceTimeHelperPeer,
  type FaceTimeHelperSocketServer,
  type HelperActionResult,
} from "./helper-rpc.js";
import { retainFaceTimeDialCallUUID, type PendingFaceTimeDial } from "./outbound-call.js";
import type { ActiveFaceTimeCall } from "./runtime-state.js";

export const OUTBOUND_DIAL_HELPER_BUNDLES = new Set([
  "com.apple.FaceTime",
  "com.apple.FaceTime.FTConversationService",
]);

function readHelperPeers(result: HelperActionResult): FaceTimeHelperPeer[] {
  const peers: FaceTimeHelperPeer[] = [];
  for (const entry of readHelperResults(result)) {
    const peer = entry.helperPeer;
    if (
      peer &&
      typeof peer === "object" &&
      "processId" in peer &&
      "bundleIdentifier" in peer &&
      "connectionGeneration" in peer &&
      "processStartedAtMs" in peer &&
      typeof peer.processId === "number" &&
      typeof peer.bundleIdentifier === "string" &&
      typeof peer.connectionGeneration === "number" &&
      typeof peer.processStartedAtMs === "number"
    ) {
      peers.push({
        bundleIdentifier: peer.bundleIdentifier,
        processId: peer.processId,
        processStartedAtMs: peer.processStartedAtMs,
        connectionGeneration: peer.connectionGeneration,
      });
    }
  }
  return peers;
}

export function retainHelperResultPeers(
  call: ActiveFaceTimeCall,
  result: HelperActionResult,
): void {
  for (const peer of readHelperPeers(result)) {
    call.carrierPeers.set(peer.processId, peer);
  }
}

export function retainOutboundDialHelperPeers(
  peers: Map<number, FaceTimeHelperPeer>,
  result: HelperActionResult,
): void {
  for (const entry of readHelperResults(result)) {
    // An absence-only observer never becomes an owner required for later closure.
    if (
      entry.found === false &&
      entry.retained_outbound_dial !== true &&
      entry.cancelled !== true
    ) {
      continue;
    }
    for (const peer of readHelperPeers(entry)) {
      if (OUTBOUND_DIAL_HELPER_BUNDLES.has(peer.bundleIdentifier)) {
        peers.set(peer.processId, peer);
      }
    }
  }
}

export function readOutboundCallUUID(result: HelperActionResult): string | undefined {
  return readHelperResults(result)
    .map((entry) =>
      typeof entry.call_uuid === "string" && entry.call_uuid.trim()
        ? entry.call_uuid.trim()
        : undefined,
    )
    .find((value) => Boolean(value));
}

export function readOutboundProxyIdentifier(result: HelperActionResult): string | undefined {
  return readHelperResults(result)
    .map((entry) =>
      typeof entry.proxy_identifier === "string" && entry.proxy_identifier.trim()
        ? entry.proxy_identifier.trim()
        : undefined,
    )
    .find((value) => Boolean(value));
}

export function hasDialHelperConfirmation(results: HelperActionResult[]): boolean {
  return results.some(
    (entry) =>
      typeof entry.helperBundleIdentifier === "string" &&
      OUTBOUND_DIAL_HELPER_BUNDLES.has(entry.helperBundleIdentifier),
  );
}

function hasDefinitiveDialHelperAbsence(
  result: HelperActionResult,
  requiredPeerProcessIds: Iterable<number>,
): boolean {
  const results = readHelperResults(result);
  const observedProcessIds = new Set(readHelperPeers(result).map((peer) => peer.processId));
  return (
    result.topologyComplete === true &&
    results.length === result.helpersContacted &&
    hasDialHelperConfirmation(results) &&
    results.every((entry) => entry.found === false && entry.retained_outbound_dial !== true) &&
    [...requiredPeerProcessIds].every((processId) => observedProcessIds.has(processId))
  );
}

export const OUTBOUND_RECONCILE_ATTEMPTS = 12;
export const OUTBOUND_RECONCILE_INTERVAL_MS = 250;

export async function reconcilePendingFaceTimeCarrier(params: {
  helper: FaceTimeHelperSocketServer;
  pending: PendingFaceTimeDial;
  isCurrent: () => boolean;
  peers: Map<number, FaceTimeHelperPeer>;
  persist: () => Promise<void>;
  clear: () => Promise<void>;
}): Promise<void> {
  const { pending } = params;
  let previousAbsentTopology: number | undefined;
  let previousAbsenceCurrent: (() => boolean) | undefined;
  for (let attempt = 0; attempt < OUTBOUND_RECONCILE_ATTEMPTS; attempt += 1) {
    if (!params.isCurrent()) {
      return;
    }
    // Native events can enrich this same pending object while its query is in flight.
    const { ownerEpoch, delivery, callUUID, proxyIdentifier } = pending;
    const aliases = new Set(pending.callUUIDAliases);
    const isSnapshotCurrent = () =>
      params.isCurrent() &&
      pending.ownerEpoch === ownerEpoch &&
      pending.delivery === delivery &&
      pending.callUUID === callUUID &&
      pending.proxyIdentifier === proxyIdentifier &&
      (pending.callUUIDAliases?.size ?? 0) === aliases.size &&
      [...aliases].every((alias) => pending.callUUIDAliases?.has(alias) === true);
    const result = await params.helper.findOutgoingCall(
      pending.handle,
      callUUID,
      pending.dialID,
      proxyIdentifier,
      pending.requestedAt,
      pending.mode,
    );
    if (!params.isCurrent()) {
      return;
    }
    if (!isSnapshotCurrent()) {
      previousAbsentTopology = undefined;
      previousAbsenceCurrent = undefined;
      continue;
    }
    retainOutboundDialHelperPeers(params.peers, result);
    const reconciledCallUUID = readOutboundCallUUID(result);
    const reconciledProxyIdentifier = readOutboundProxyIdentifier(result);
    if (reconciledCallUUID || reconciledProxyIdentifier) {
      retainFaceTimeDialCallUUID(pending, reconciledCallUUID);
      if (reconciledProxyIdentifier) {
        pending.proxyIdentifier = reconciledProxyIdentifier;
      }
      await params.persist();
    }
    if (
      reconciledCallUUID ||
      reconciledProxyIdentifier ||
      readHelperResults(result).some((entry) => entry.found === true)
    ) {
      return;
    }
    const topologyGeneration =
      typeof result.topologyGeneration === "number" ? result.topologyGeneration : undefined;
    const completeAbsence = hasDefinitiveDialHelperAbsence(result, params.peers.keys());
    if (
      completeAbsence &&
      topologyGeneration !== undefined &&
      topologyGeneration === previousAbsentTopology &&
      previousAbsenceCurrent?.()
    ) {
      await params.clear();
      return;
    }
    previousAbsentTopology = completeAbsence ? topologyGeneration : undefined;
    previousAbsenceCurrent = completeAbsence ? isSnapshotCurrent : undefined;
    if (attempt + 1 < OUTBOUND_RECONCILE_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, OUTBOUND_RECONCILE_INTERVAL_MS);
      });
    }
  }
}
