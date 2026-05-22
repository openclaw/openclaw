import { a as buildFeishuConversationId, c as parseFeishuDirectConversationId, l as parseFeishuTargetId, n as createFeishuThreadBindingManager, s as parseFeishuConversationId, t as __testing } from "../../thread-bindings-jc_15_R9.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-PxVOfMKU.js";
import { t as collectFeishuSecurityAuditFindings } from "../../security-audit-shared-dcH6gKgk.js";

//#region extensions/feishu/src/message-action-contract.d.ts
declare const messageActionTargetAliases: {
  read: {
    aliases: string[];
  };
  pin: {
    aliases: string[];
  };
  unpin: {
    aliases: string[];
  };
  "list-pins": {
    aliases: string[];
  };
  "channel-info": {
    aliases: string[];
  };
};
//#endregion
//#region extensions/feishu/contract-api.d.ts
declare const feishuSessionBindingAdapterChannels: readonly ["feishu"];
//#endregion
export { buildFeishuConversationId, collectFeishuSecurityAuditFindings, collectRuntimeConfigAssignments, createFeishuThreadBindingManager, feishuSessionBindingAdapterChannels, __testing as feishuThreadBindingTesting, messageActionTargetAliases, parseFeishuConversationId, parseFeishuDirectConversationId, parseFeishuTargetId, secretTargetRegistryEntries };