import { t as BaseProbeResult } from "./types.core-DrB_kWzl.js";
import { n as ChannelPlugin } from "./types.public-C5MFEvPW.js";
import { t as ResolvedMatrixAccount } from "./accounts-COqhILrv.js";
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