import { t as BaseProbeResult } from "./types.core-BoZgMdCh.js";
import { n as ChannelPlugin } from "./types.public-Bp4rl8_W.js";
import { t as ResolvedMatrixAccount } from "./accounts-Dt8HQBJB.js";
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