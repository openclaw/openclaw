import { t as BaseProbeResult } from "./types.core-gexONR-2.js";
import { n as ChannelPlugin } from "./types.public-D_xOTs5v.js";
import { o as ResolvedZalouserAccount, p as ZcaUserInfo } from "./accounts-C_d8Ig4W.js";
//#region extensions/zalouser/src/probe.d.ts
type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};
//#endregion
//#region extensions/zalouser/src/channel.d.ts
declare const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult>;
//#endregion
export { zalouserPlugin as t };