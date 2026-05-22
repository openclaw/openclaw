import { C as OpenClawPluginApi } from "../../types-WgmX6DKe.js";
import { n as handleFeishuSubagentEnded, r as handleFeishuSubagentSpawning, t as handleFeishuSubagentDeliveryTarget } from "../../subagent-hooks-BQvKrSz5.js";

//#region extensions/feishu/subagent-hooks-api.d.ts
declare function registerFeishuSubagentHooks(api: OpenClawPluginApi): void;
//#endregion
export { handleFeishuSubagentDeliveryTarget, handleFeishuSubagentEnded, handleFeishuSubagentSpawning, registerFeishuSubagentHooks };