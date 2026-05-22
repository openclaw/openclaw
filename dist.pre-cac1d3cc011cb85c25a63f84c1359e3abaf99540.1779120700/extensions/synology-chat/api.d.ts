import { n as PluginRuntime } from "../../types-taiLI91p.js";
import { t as synologyChatPlugin } from "../../channel-BmVvfMM8.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-DVOSmgCM.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };