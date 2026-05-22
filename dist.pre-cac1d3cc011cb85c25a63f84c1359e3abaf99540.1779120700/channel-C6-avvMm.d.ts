import { t as BaseProbeResult } from "./types.core-zIW2Gjsy.js";
import { n as ChannelPlugin } from "./types.public-JfHpZqwR.js";
import { o as ResolvedZalouserAccount, p as ZcaUserInfo } from "./accounts-CBv8mK2T.js";
//#region extensions/zalouser/src/probe.d.ts
type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};
//#endregion
//#region extensions/zalouser/src/channel.d.ts
declare const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult>;
//#endregion
export { zalouserPlugin as t };