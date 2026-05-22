import { t as BaseProbeResult } from "./types.core-C6a4QJNn.js";
import { n as ChannelPlugin } from "./types.public-0ZbPwK4W.js";
import { t as ResolvedMatrixAccount } from "./accounts-BUXTrRpj.js";
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