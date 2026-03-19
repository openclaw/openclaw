import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import { resolveMatrixAuth } from "./matrix/client.js";
import { probeMatrix } from "./matrix/probe.js";
import { sendMessageMatrix } from "./matrix/send.js";
import { resolveMatrixTargets } from "./resolve-targets.js";

export const matrixChannelRuntime = {
  listMatrixDirectoryGroupsLive,
  listMatrixDirectoryPeersLive,
  probeMatrix,
  resolveMatrixAuth,
  resolveMatrixTargets,
  sendMessageMatrix,
};
