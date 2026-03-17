import {
  listMatrixDirectoryGroupsLive as listMatrixDirectoryGroupsLiveImpl,
  listMatrixDirectoryPeersLive as listMatrixDirectoryPeersLiveImpl,
} from "./directory-live.js";
import { resolveMatrixAuth as resolveMatrixAuthImpl } from "./matrix/client.js";
import { probeMatrix as probeMatrixImpl } from "./matrix/probe.js";
import { sendMessageMatrix as sendMessageMatrixImpl } from "./matrix/send.js";
import { matrixOutbound as matrixOutboundImpl } from "./outbound.js";
import { resolveMatrixTargets as resolveMatrixTargetsImpl } from "./resolve-targets.js";

type ListMatrixDirectoryGroupsLive =
  typeof import("./directory-live.js").listMatrixDirectoryGroupsLive;
type ListMatrixDirectoryPeersLive =
  typeof import("./directory-live.js").listMatrixDirectoryPeersLive;
type ResolveMatrixAuth = typeof import("./matrix/client.js").resolveMatrixAuth;
type ProbeMatrix = typeof import("./matrix/probe.js").probeMatrix;
type SendMessageMatrix = typeof import("./matrix/send.js").sendMessageMatrix;
type ResolveMatrixTargets = typeof import("./resolve-targets.js").resolveMatrixTargets;
type MatrixOutbound = typeof import("./outbound.js").matrixOutbound;

export function listMatrixDirectoryGroupsLive(
  ...args: Parameters<ListMatrixDirectoryGroupsLive>
): ReturnType<ListMatrixDirectoryGroupsLive> {
  return listMatrixDirectoryGroupsLiveImpl(...args);
}

export function listMatrixDirectoryPeersLive(
  ...args: Parameters<ListMatrixDirectoryPeersLive>
): ReturnType<ListMatrixDirectoryPeersLive> {
  return listMatrixDirectoryPeersLiveImpl(...args);
}

export function resolveMatrixAuth(
  ...args: Parameters<ResolveMatrixAuth>
): ReturnType<ResolveMatrixAuth> {
  return resolveMatrixAuthImpl(...args);
}

export function probeMatrix(...args: Parameters<ProbeMatrix>): ReturnType<ProbeMatrix> {
  return probeMatrixImpl(...args);
}

export function sendMessageMatrix(
  ...args: Parameters<SendMessageMatrix>
): ReturnType<SendMessageMatrix> {
  return sendMessageMatrixImpl(...args);
}

export function resolveMatrixTargets(
  ...args: Parameters<ResolveMatrixTargets>
): ReturnType<ResolveMatrixTargets> {
  return resolveMatrixTargetsImpl(...args);
}

export const matrixOutbound: MatrixOutbound = { ...matrixOutboundImpl };
