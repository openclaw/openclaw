import { n as PluginRuntime } from "../../types-DVhGJHIy.js";
import { t as synologyChatPlugin } from "../../channel-BQWeA29E.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-CwCNK57L.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };