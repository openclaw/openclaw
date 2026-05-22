import { t as BaseProbeResult } from "./types.core-CgjRAtD6.js";
import { n as ChannelPlugin } from "./types.public-Dl9p3tAM.js";
import { o as ResolvedZalouserAccount, p as ZcaUserInfo } from "./accounts-BQ37CJJy.js";
//#region extensions/zalouser/src/probe.d.ts
type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};
//#endregion
//#region extensions/zalouser/src/channel.d.ts
declare const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult>;
//#endregion
export { zalouserPlugin as t };