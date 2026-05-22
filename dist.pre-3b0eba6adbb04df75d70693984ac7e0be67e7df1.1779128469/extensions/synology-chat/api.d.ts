import { n as PluginRuntime } from "../../types-DIe2gsAQ.js";
import { t as synologyChatPlugin } from "../../channel-DtmiwlXm.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-D7WSCLoz.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };