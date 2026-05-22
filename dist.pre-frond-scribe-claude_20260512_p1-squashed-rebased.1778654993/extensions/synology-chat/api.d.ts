import { n as PluginRuntime } from "../../types-Czv_rpgT.js";
import { t as synologyChatPlugin } from "../../channel-C6_dDDht.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-Bz_QQvid.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };