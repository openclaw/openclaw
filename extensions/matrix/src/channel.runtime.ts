import {
  listMatrixDirectoryGroupsLive as listMatrixDirectoryGroupsLiveImpl,
  listMatrixDirectoryPeersLive as listMatrixDirectoryPeersLiveImpl,
} from "./directory-live.js";
import { resolveMatrixAuth as resolveMatrixAuthImpl } from "./matrix/client.js";
import { probeMatrix as probeMatrixImpl } from "./matrix/probe.js";
import { sendMessageMatrix as sendMessageMatrixImpl } from "./matrix/send.js";
import { matrixOutbound as matrixOutboundImpl } from "./outbound.js";
import { resolveMatrixTargets as resolveMatrixTargetsImpl } from "./resolve-targets.js";
export const matrixChannelRuntime = {
  listMatrixDirectoryGroupsLive: listMatrixDirectoryGroupsLiveImpl,
  listMatrixDirectoryPeersLive: listMatrixDirectoryPeersLiveImpl,
  resolveMatrixAuth: resolveMatrixAuthImpl,
  probeMatrix: probeMatrixImpl,
  sendMessageMatrix: sendMessageMatrixImpl,
  resolveMatrixTargets: resolveMatrixTargetsImpl,
  matrixOutbound: { ...matrixOutboundImpl },
};
