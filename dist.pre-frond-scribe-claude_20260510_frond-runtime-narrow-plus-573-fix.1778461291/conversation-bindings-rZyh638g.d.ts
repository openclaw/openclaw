import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { t as AccountScopedConversationBindingManager } from "./thread-bindings-runtime-CT6koh8Q.js";

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