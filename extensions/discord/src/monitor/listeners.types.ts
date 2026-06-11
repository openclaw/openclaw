import type {
  Client,
  InteractionCreateListener,
  MessageCreateListener,
} from "../internal/discord.js";

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];
export type DiscordInteractionEvent = Parameters<InteractionCreateListener["handle"]>[0];

export type DiscordMessageHandler = (
  data: DiscordMessageEvent,
  client: Client,
  options?: { abortSignal?: AbortSignal },
) => Promise<void>;
