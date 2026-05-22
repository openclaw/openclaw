import { t as BaseProbeResult } from "./types.core-DWkvQuBM.js";
import { n as ChannelPlugin } from "./types.public-i4hJTC6b.js";
import { o as ResolvedZalouserAccount, p as ZcaUserInfo } from "./accounts-BBgGj3y2.js";
//#region extensions/zalouser/src/probe.d.ts
type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};
//#endregion
//#region extensions/zalouser/src/channel.d.ts
declare const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult>;
//#endregion
export { zalouserPlugin as t };