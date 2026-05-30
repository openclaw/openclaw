import type {
  DiscordInteractiveHandlerContext,
  DiscordInteractiveHandlerRegistration,
} from "openclaw/plugin-sdk/discord-interactions";
import {
  createInteractiveConversationBindingHelpers,
  dispatchPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";

export type {
  DiscordInteractiveHandlerContext,
  DiscordInteractiveHandlerRegistration,
} from "openclaw/plugin-sdk/discord-interactions";

type DiscordInteractiveDispatchContext = Omit<
  DiscordInteractiveHandlerContext,
  | "interaction"
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  interaction: Omit<
    DiscordInteractiveHandlerContext["interaction"],
    "data" | "namespace" | "payload"
  >;
};

export async function dispatchDiscordPluginInteractiveHandler(params: {
  data: string;
  interactionId: string;
  ctx: DiscordInteractiveDispatchContext;
  respond: DiscordInteractiveHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
}) {
  return await dispatchPluginInteractiveHandler<DiscordInteractiveHandlerRegistration>({
    channel: "discord",
    data: params.data,
    dedupeId: params.interactionId,
    onMatched: params.onMatched,
    invoke: ({ registration, namespace, payload }) =>
      registration.handler({
        ...params.ctx,
        channel: "discord",
        interaction: {
          ...params.ctx.interaction,
          data: params.data,
          namespace,
          payload,
        },
        respond: params.respond,
        ...createInteractiveConversationBindingHelpers({
          registration,
          senderId: params.ctx.senderId,
          conversation: {
            channel: "discord",
            accountId: params.ctx.accountId,
            conversationId: params.ctx.conversationId,
            parentConversationId: params.ctx.parentConversationId,
          },
        }),
      }),
  });
}
