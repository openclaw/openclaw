import { n as PluginRuntime } from "../../types-_VshWtBa.js";
import { t as synologyChatPlugin } from "../../channel-BCT2z5xm.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-B7UtMSwn.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };