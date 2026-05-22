import { t as BaseProbeResult } from "./types.core-DA-emjB6.js";
import { n as ChannelPlugin } from "./types.public-Cx-Og-oG.js";
import { t as ResolvedMatrixAccount } from "./accounts-6zXyJaW7.js";
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