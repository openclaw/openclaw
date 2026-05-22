import { n as PluginRuntime } from "../../types-DLVUU0yv.js";
import { t as synologyChatPlugin } from "../../channel-DZ37B-xn.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-CMO6u87U.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };