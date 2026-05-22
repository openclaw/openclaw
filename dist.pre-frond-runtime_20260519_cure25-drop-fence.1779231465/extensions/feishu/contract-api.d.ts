import { a as buildFeishuConversationId, c as parseFeishuDirectConversationId, l as parseFeishuTargetId, r as testing, s as parseFeishuConversationId, t as createFeishuThreadBindingManager } from "../../thread-bindings-Csmvuvy4.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-ietg__Qn.js";
import { t as collectFeishuSecurityAuditFindings } from "../../security-audit-shared-BazZtgUk.js";

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
export { buildFeishuConversationId, collectFeishuSecurityAuditFindings, collectRuntimeConfigAssignments, createFeishuThreadBindingManager, feishuSessionBindingAdapterChannels, testing as feishuThreadBindingTesting, messageActionTargetAliases, parseFeishuConversationId, parseFeishuDirectConversationId, parseFeishuTargetId, secretTargetRegistryEntries };