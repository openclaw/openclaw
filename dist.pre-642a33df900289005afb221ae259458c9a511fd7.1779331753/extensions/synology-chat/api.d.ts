import { n as PluginRuntime } from "../../types-AFN3jLI5.js";
import { t as synologyChatPlugin } from "../../channel-jRvQCe0F.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit-9EGcNasg.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };