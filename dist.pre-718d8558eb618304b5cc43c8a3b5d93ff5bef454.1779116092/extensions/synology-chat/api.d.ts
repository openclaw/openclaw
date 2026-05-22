import { n as PluginRuntime } from "../../types-1xy7Ddy0.js";
import { t as synologyChatPlugin } from "../../channel-lNBN40cu.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-DPiOvQP5.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };