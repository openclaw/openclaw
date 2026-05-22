import { t as BaseProbeResult } from "./types.core-C6a4QJNn.js";
import { n as ChannelPlugin } from "./types.public-0ZbPwK4W.js";
import { o as ResolvedZalouserAccount, p as ZcaUserInfo } from "./accounts-CglTH07R.js";
//#region extensions/zalouser/src/probe.d.ts
type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};
//#endregion
//#region extensions/zalouser/src/channel.d.ts
declare const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult>;
//#endregion
export { zalouserPlugin as t };