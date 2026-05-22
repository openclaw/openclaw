import { L as ChannelStructuredComponents } from "./types.core-CcKckzwX.js";
import { ut as PluginInteractiveRegistration } from "./types-wNLvWYuA.js";
import { Gt as PluginConversationBindingRequestParams, Kt as PluginConversationBindingRequestResult, Wt as PluginConversationBinding } from "./hook-types-AyXrRN7k.js";
//#region extensions/discord/src/interactive-dispatch.d.ts
type DiscordInteractiveHandlerContext = {
  channel: "discord";
  accountId: string;
  interactionId: string;
  conversationId: string;
  parentConversationId?: string;
  guildId?: string;
  senderId?: string;
  senderUsername?: string;
  auth: {
    isAuthorizedSender: boolean;
  };
  interaction: {
    kind: "button" | "select" | "modal";
    data: string;
    namespace: string;
    payload: string;
    messageId?: string;
    values?: string[];
    fields?: Array<{
      id: string;
      name: string;
      values: string[];
    }>;
  };
  respond: {
    acknowledge: () => Promise<void>;
    reply: (params: {
      text: string;
      ephemeral?: boolean;
    }) => Promise<void>;
    followUp: (params: {
      text: string;
      ephemeral?: boolean;
    }) => Promise<void>;
    editMessage: (params: {
      text?: string;
      components?: ChannelStructuredComponents;
    }) => Promise<void>;
    clearComponents: (params?: {
      text?: string;
    }) => Promise<void>;
  };
  requestConversationBinding: (params?: PluginConversationBindingRequestParams) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{
    removed: boolean;
  }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};
type DiscordInteractiveHandlerRegistration = PluginInteractiveRegistration<DiscordInteractiveHandlerContext, "discord">;
//#endregion
export { DiscordInteractiveHandlerRegistration as n, DiscordInteractiveHandlerContext as t };