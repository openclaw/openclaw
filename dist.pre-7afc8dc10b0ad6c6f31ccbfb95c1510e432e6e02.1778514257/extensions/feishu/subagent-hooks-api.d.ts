import { g as OpenClawPluginApi } from "../../types-BOTb5nyG.js";
import { n as handleFeishuSubagentEnded, r as handleFeishuSubagentSpawning, t as handleFeishuSubagentDeliveryTarget } from "../../subagent-hooks-CMdHk-yK.js";

//#region extensions/feishu/subagent-hooks-api.d.ts
declare function registerFeishuSubagentHooks(api: OpenClawPluginApi): void;
//#endregion
export { handleFeishuSubagentDeliveryTarget, handleFeishuSubagentEnded, handleFeishuSubagentSpawning, registerFeishuSubagentHooks };