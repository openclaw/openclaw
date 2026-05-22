import { n as PluginRuntime } from "../../types-C2b0JJwH.js";
import { t as synologyChatPlugin } from "../../channel-BsTJqvrm.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-BTD1p_MZ.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };