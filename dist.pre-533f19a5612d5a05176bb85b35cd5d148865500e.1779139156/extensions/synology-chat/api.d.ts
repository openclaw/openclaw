import { n as PluginRuntime } from "../../types-Dsa-0Faj.js";
import { t as synologyChatPlugin } from "../../channel-eb597dGl.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-CpOkh7wf.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };