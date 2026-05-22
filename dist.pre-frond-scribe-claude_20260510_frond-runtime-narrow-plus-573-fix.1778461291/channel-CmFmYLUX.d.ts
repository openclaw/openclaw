import { t as BaseProbeResult } from "./types.core-CQScvK0N.js";
import { n as ChannelPlugin } from "./types.public-BMrZTIWg.js";
import { o as ResolvedZalouserAccount, p as ZcaUserInfo } from "./accounts-vgrGVJ_K.js";
//#region extensions/zalouser/src/probe.d.ts
type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};
//#endregion
//#region extensions/zalouser/src/channel.d.ts
declare const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult>;
//#endregion
export { zalouserPlugin as t };