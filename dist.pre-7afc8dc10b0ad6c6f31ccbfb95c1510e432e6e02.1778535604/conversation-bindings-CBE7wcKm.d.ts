import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { t as AccountScopedConversationBindingManager } from "./thread-bindings-runtime-CQW1TvKQ.js";

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