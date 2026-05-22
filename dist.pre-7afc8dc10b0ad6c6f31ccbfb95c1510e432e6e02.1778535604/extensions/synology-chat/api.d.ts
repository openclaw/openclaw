import { n as PluginRuntime } from "../../types-C2b0JJwH.js";
import { t as synologyChatPlugin } from "../../channel-CHJLD3LK.js";
import { t as collectSynologyChatSecurityAuditFindings } from "../../security-audit--qEX4MP0.js";

//#region extensions/synology-chat/src/runtime.d.ts
declare const setSynologyRuntime: (next: PluginRuntime) => void, getSynologyRuntime: () => PluginRuntime;
//#endregion
export { collectSynologyChatSecurityAuditFindings, setSynologyRuntime, synologyChatPlugin };