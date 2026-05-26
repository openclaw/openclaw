import { lt as PluginInteractiveRegistration } from "./types-lCXG2pW_.js";
import { Gt as PluginConversationBindingRequestResult, Ut as PluginConversationBinding, Wt as PluginConversationBindingRequestParams } from "./hook-types-CECscVcN.js";
//#region extensions/slack/src/interactive-dispatch.d.ts
type SlackInteractiveHandlerContext = {
  channel: "slack";
  accountId: string;
  interactionId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId?: string;
  senderUsername?: string;
  threadId?: string;
  auth: {
    isAuthorizedSender: boolean;
  };
  interaction: {
    kind: "button" | "select";
    data: string;
    namespace: string;
    payload: string;
    actionId: string;
    blockId?: string;
    messageTs?: string;
    threadTs?: string;
    value?: string;
    selectedValues?: string[];
    selectedLabels?: string[];
    triggerId?: string;
    responseUrl?: string;
  };
  respond: {
    acknowledge: () => Promise<void>;
    reply: (params: {
      text: string;
      responseType?: "ephemeral" | "in_channel";
    }) => Promise<void>;
    followUp: (params: {
      text: string;
      responseType?: "ephemeral" | "in_channel";
    }) => Promise<void>;
    editMessage: (params: {
      text?: string;
      blocks?: unknown[];
    }) => Promise<void>;
  };
  requestConversationBinding: (params?: PluginConversationBindingRequestParams) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{
    removed: boolean;
  }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};
type SlackInteractiveHandlerRegistration = PluginInteractiveRegistration<SlackInteractiveHandlerContext, "slack">;
//#endregion
export { SlackInteractiveHandlerRegistration as n, SlackInteractiveHandlerContext as t };