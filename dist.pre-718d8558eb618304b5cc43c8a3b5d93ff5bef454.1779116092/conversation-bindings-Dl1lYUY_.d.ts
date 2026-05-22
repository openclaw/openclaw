import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { t as AccountScopedConversationBindingManager } from "./thread-bindings-runtime-CqhesCy5.js";

//#region extensions/imessage/src/conversation-bindings.d.ts
type IMessageBindingTargetKind = "subagent" | "acp";
type IMessageConversationBindingManager = AccountScopedConversationBindingManager<IMessageBindingTargetKind>;
declare function createIMessageConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): IMessageConversationBindingManager;
declare const __testing: {
  resetIMessageConversationBindingsForTests(): void;
};
//#endregion
export { createIMessageConversationBindingManager as n, __testing as t };