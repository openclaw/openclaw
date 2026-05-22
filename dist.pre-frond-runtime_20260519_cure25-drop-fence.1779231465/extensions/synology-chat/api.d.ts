import { n as PluginRuntime } from "../../types-CXGnubLv.js";
import { t as synologyChatPlugin } from "../../channel-BtU1BgMc.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-C1Vz6B0i.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };