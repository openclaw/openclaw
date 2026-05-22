import { t as BaseProbeResult } from "./types.core-DiLRQ15F.js";
import { n as ChannelPlugin } from "./types.public-BGobpRnR.js";
import { t as ResolvedMatrixAccount } from "./accounts-CAg7fJ9-.js";
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