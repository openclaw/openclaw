import { t as BaseProbeResult } from "./types.core-CQScvK0N.js";
import { n as ChannelPlugin } from "./types.public-BMrZTIWg.js";
import { t as ResolvedMatrixAccount } from "./accounts-DCz3KF88.js";
//#region extensions/matrix/src/matrix/probe.d.ts
type MatrixProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  userId?: string | null;
};
//#endregion
//#region extensions/matrix/src/channel.d.ts
declare const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount, MatrixProbe>;
//#endregion
export { matrixPlugin as t };