// Nextcloud Talk plugin module implements message adapter behavior.
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

export const nextcloudTalkMessageAdapter = defineChannelMessageAdapter({
  id: "nextcloud-talk",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
    },
  },
  send: {
    text: async (ctx) =>
      await sendMessageNextcloudTalk(ctx.to, ctx.text, {
        accountId: ctx.accountId ?? undefined,
        replyTo: ctx.replyToId ?? undefined,
        cfg: ctx.cfg as CoreConfig,
        onPlatformSendDispatch: ctx.onPlatformSendDispatch,
        assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
      }),
    media: async (ctx) =>
      await sendMessageNextcloudTalk(
        ctx.to,
        ctx.mediaUrl ? `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}` : ctx.text,
        {
          accountId: ctx.accountId ?? undefined,
          replyTo: ctx.replyToId ?? undefined,
          cfg: ctx.cfg as CoreConfig,
          onPlatformSendDispatch: ctx.onPlatformSendDispatch,
          assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
        },
      ),
  },
});
