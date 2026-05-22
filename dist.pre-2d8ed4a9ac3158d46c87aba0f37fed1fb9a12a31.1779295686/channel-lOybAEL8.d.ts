import { t as BaseProbeResult } from "./types.core-remGx4m5.js";
import { n as ChannelPlugin } from "./types.public-BlA4mimK.js";
import { t as ResolvedMatrixAccount } from "./accounts-Dznn1wjD.js";
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