import { C as OpenClawPluginApi } from "../../types-UTp4ves_.js";
import { t as feishuPlugin } from "../../channel-CXmcXig3.js";
import { n as handleFeishuSubagentEnded, r as handleFeishuSubagentSpawning, t as handleFeishuSubagentDeliveryTarget } from "../../subagent-hooks-DdUO0lm4.js";
import { a as buildFeishuConversationId, c as parseFeishuDirectConversationId, i as FeishuGroupSessionScope, l as parseFeishuTargetId, n as createFeishuThreadBindingManager, o as buildFeishuModelOverrideParentCandidates, r as getFeishuThreadBindingManager, s as parseFeishuConversationId, t as __testing } from "../../thread-bindings-QxLDmLx6.js";
import { i as setFeishuNamedAccountEnabled, n as runFeishuLogin, r as feishuSetupAdapter, t as feishuSetupWizard } from "../../setup-surface-BgPYtMYM.js";
import { t as createClackPrompter } from "../../setup-runtime-lPG8a4bU.js";
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