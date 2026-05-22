import { t as BaseProbeResult } from "./types.core-yC1NCFUF.js";
import { n as ChannelPlugin } from "./types.public-hz1J9-y_.js";
import { t as ResolvedMatrixAccount } from "./accounts-CaEEFmil.js";
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