import { t as BaseProbeResult } from "./types.core-yC1NCFUF.js";
import { n as ChannelPlugin } from "./types.public-hz1J9-y_.js";
import { o as ResolvedZalouserAccount, p as ZcaUserInfo } from "./accounts-Ct368RYn.js";
//#region extensions/zalouser/src/probe.d.ts
type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};
//#endregion
//#region extensions/zalouser/src/channel.d.ts
declare const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult>;
//#endregion
export { zalouserPlugin as t };