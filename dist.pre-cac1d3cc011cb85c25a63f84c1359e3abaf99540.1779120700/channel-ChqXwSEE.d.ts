import { t as BaseProbeResult } from "./types.core-zIW2Gjsy.js";
import { n as ChannelPlugin } from "./types.public-JfHpZqwR.js";
import { t as ResolvedMatrixAccount } from "./accounts-VP6OunrL.js";
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