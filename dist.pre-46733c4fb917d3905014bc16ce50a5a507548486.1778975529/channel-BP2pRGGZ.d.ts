import { t as BaseProbeResult } from "./types.core-BHltg72J.js";
import { n as ChannelPlugin } from "./types.public-DObS_ia-.js";
import { t as ResolvedMatrixAccount } from "./accounts-DP9LdlKJ.js";
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