import { t as BaseProbeResult } from "./types.core-1gJzFdXJ.js";
import { n as ChannelPlugin } from "./types.public-oY5Zsold.js";
import { o as ResolvedZalouserAccount, p as ZcaUserInfo } from "./accounts-CnBAtIcZ.js";
//#region extensions/zalouser/src/probe.d.ts
type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};
//#endregion
//#region extensions/zalouser/src/channel.d.ts
declare const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult>;
//#endregion
export { zalouserPlugin as t };