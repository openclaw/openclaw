import { n as PluginRuntime } from "../../types-6GKVZ6OQ.js";
import { t as synologyChatPlugin } from "../../channel-_lmJJadm.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-7uWi5uJx.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };