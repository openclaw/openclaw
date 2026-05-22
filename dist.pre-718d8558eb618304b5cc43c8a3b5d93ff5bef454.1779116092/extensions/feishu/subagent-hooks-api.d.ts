import { y as OpenClawPluginApi } from "../../types-CWJThuOe2.js";
import { n as handleFeishuSubagentEnded, r as handleFeishuSubagentSpawning, t as handleFeishuSubagentDeliveryTarget } from "../../subagent-hooks-QkZ7Yst9.js";

//#region extensions/feishu/subagent-hooks-api.d.ts
declare function registerFeishuSubagentHooks(api: OpenClawPluginApi): void;
//#endregion
export { handleFeishuSubagentDeliveryTarget, handleFeishuSubagentEnded, handleFeishuSubagentSpawning, registerFeishuSubagentHooks };