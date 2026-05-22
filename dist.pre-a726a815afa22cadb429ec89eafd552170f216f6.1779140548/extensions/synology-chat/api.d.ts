import { n as PluginRuntime } from "../../types-CXGnubLv.js";
import { t as synologyChatPlugin } from "../../channel-C8Iv-Snj.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-B74sSlCE.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };