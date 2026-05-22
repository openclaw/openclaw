import { n as PluginRuntime } from "../../types-6l5HWcJc.js";
import { t as synologyChatPlugin } from "../../channel-ChsZPloH.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-Dcri0Vcd.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };