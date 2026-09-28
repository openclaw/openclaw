import {
  defineChannelMessageAdapter,
  type ChannelMessageSendTextContext,
} from "openclaw/plugin-sdk/channel-outbound";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

function sendNextcloudTalkMessage(ctx: ChannelMessageSendTextContext, text = ctx.text) {
  return sendMessageNextcloudTalk(ctx.to, text, {
    accountId: ctx.accountId ?? undefined,
    replyTo: ctx.replyToId ?? undefined,
    cfg: ctx.cfg as CoreConfig,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
  });
}

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
    text: sendNextcloudTalkMessage,
    media: (ctx) =>
      sendNextcloudTalkMessage(
        ctx,
        ctx.mediaUrl ? `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}` : ctx.text,
      ),
  },
});
