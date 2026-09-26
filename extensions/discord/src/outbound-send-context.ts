import {
  createReplyToFanout,
  resolveOutboundSendDep,
  type OutboundSendDeps,
  type ReplyToResolution,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveDiscordAttachedOutboundTarget } from "./channel.conversation.js";
import { resolveDiscordReplyReference } from "./reply-reference.js";

type DiscordSendRuntime = typeof import("./send.js");

export type DiscordSendFn = DiscordSendRuntime["sendMessageDiscord"];
export type DiscordVoiceSendFn = DiscordSendRuntime["sendVoiceMessageDiscord"];
type DiscordFormattingOptions = {
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: NonNullable<Parameters<DiscordSendFn>[2]>["tableMode"];
  chunkMode?: NonNullable<Parameters<DiscordSendFn>[2]>["chunkMode"];
};

export const loadDiscordSendRuntime = createLazyRuntimeModule(() => import("./send.js"));

export function resolveDiscordFormattingOptions(ctx: {
  formatting?: DiscordFormattingOptions;
}): DiscordFormattingOptions {
  const formatting = ctx.formatting;
  return {
    textLimit: formatting?.textLimit,
    maxLinesPerMessage: formatting?.maxLinesPerMessage,
    tableMode: formatting?.tableMode,
    chunkMode: formatting?.chunkMode,
  };
}

export async function createDiscordPayloadSendContext(ctx: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  replyToIdSource?: ReplyToResolution["source"];
  replyToMode?: ReplyToMode;
  formatting?: DiscordFormattingOptions;
  threadId?: string | number | null;
}): Promise<{
  target: string;
  formatting: DiscordFormattingOptions;
  resolveReply: () => ReturnType<typeof resolveDiscordReplyReference>;
  send: DiscordSendFn;
  sendVoice: DiscordVoiceSendFn;
}> {
  const runtime = await loadDiscordSendRuntime();
  const nextReplyToId = createReplyToFanout(ctx);
  return {
    target: resolveDiscordAttachedOutboundTarget({ to: ctx.to, threadId: ctx.threadId }),
    formatting: resolveDiscordFormattingOptions(ctx),
    resolveReply: () =>
      resolveDiscordReplyReference({
        replyToId: nextReplyToId(),
        replyToIdSource: ctx.replyToIdSource,
        replyToMode: ctx.replyToMode,
      }),
    send: resolveOutboundSendDep<DiscordSendFn>(ctx.deps, "discord") ?? runtime.sendMessageDiscord,
    sendVoice:
      resolveOutboundSendDep<DiscordVoiceSendFn>(ctx.deps, "discordVoice") ??
      runtime.sendVoiceMessageDiscord,
  };
}
