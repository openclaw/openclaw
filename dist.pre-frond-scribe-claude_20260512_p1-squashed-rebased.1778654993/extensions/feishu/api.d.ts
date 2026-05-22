import { v as OpenClawPluginApi } from "../../types-ItMBrbf4.js";
import { t as feishuPlugin } from "../../channel-BKyBSocN.js";
import { n as handleFeishuSubagentEnded, r as handleFeishuSubagentSpawning, t as handleFeishuSubagentDeliveryTarget } from "../../subagent-hooks-DQEfsOP9.js";
import { a as buildFeishuConversationId, c as parseFeishuDirectConversationId, i as FeishuGroupSessionScope, l as parseFeishuTargetId, n as createFeishuThreadBindingManager, o as buildFeishuModelOverrideParentCandidates, r as getFeishuThreadBindingManager, s as parseFeishuConversationId, t as __testing } from "../../thread-bindings-CSvx-TTx.js";
import { i as setFeishuNamedAccountEnabled, n as runFeishuLogin, r as feishuSetupAdapter, t as feishuSetupWizard } from "../../setup-surface-CtpVCEi7.js";
import { t as createClackPrompter } from "../../setup-runtime-DUU3Kpvy.js";
//#region extensions/feishu/src/docx.d.ts
declare function registerFeishuDocTools(api: OpenClawPluginApi): void;
//#endregion
//#region extensions/feishu/src/chat.d.ts
declare function registerFeishuChatTools(api: OpenClawPluginApi): void;
//#endregion
//#region extensions/feishu/src/wiki.d.ts
declare function registerFeishuWikiTools(api: OpenClawPluginApi): void;
//#endregion
//#region extensions/feishu/src/drive.d.ts
declare function registerFeishuDriveTools(api: OpenClawPluginApi): void;
//#endregion
//#region extensions/feishu/src/perm.d.ts
declare function registerFeishuPermTools(api: OpenClawPluginApi): void;
//#endregion
//#region extensions/feishu/src/bitable.d.ts
declare function registerFeishuBitableTools(api: OpenClawPluginApi): void;
//#endregion
//#region extensions/feishu/api.d.ts
declare const feishuSessionBindingAdapterChannels: readonly ["feishu"];
//#endregion
export { type FeishuGroupSessionScope, __testing, __testing as feishuThreadBindingTesting, buildFeishuConversationId, buildFeishuModelOverrideParentCandidates, createClackPrompter, createFeishuThreadBindingManager, feishuPlugin, feishuSessionBindingAdapterChannels, feishuSetupAdapter, feishuSetupWizard, getFeishuThreadBindingManager, handleFeishuSubagentDeliveryTarget, handleFeishuSubagentEnded, handleFeishuSubagentSpawning, parseFeishuConversationId, parseFeishuDirectConversationId, parseFeishuTargetId, registerFeishuBitableTools, registerFeishuChatTools, registerFeishuDocTools, registerFeishuDriveTools, registerFeishuPermTools, registerFeishuWikiTools, runFeishuLogin, setFeishuNamedAccountEnabled };