import { n as PluginRuntime } from "../../types-4PahHl43.js";
import { t as synologyChatPlugin } from "../../channel-CBds0N2J.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-CX5bMcph.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };