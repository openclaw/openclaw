import {
  defineChannelMessageAdapter,
  type ChannelMessageSendTextContext,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

function isWebAttachmentUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x20 || code === 0x7f;
      })
    );
  } catch {
    return false;
  }
}

function sendNextcloudTalkMessage(
  ctx: Omit<ChannelMessageSendTextContext, "onDeliveryResult">,
  text = ctx.text,
) {
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
    media: async (ctx) => {
      if (!ctx.mediaUrl) {
        return sendNextcloudTalkMessage(ctx);
      }
      const account = resolveNextcloudTalkAccount({
        cfg: ctx.cfg as CoreConfig,
        accountId: ctx.accountId,
      });
      // Keep existing bot-only web links working without fetching their bytes.
      // Partial/unavailable API configuration and all attempted native sends
      // must fail explicitly, never silently retry through the bot transport.
      if (
        account.enabled &&
        !account.config.apiUser?.trim() &&
        account.config.apiPassword === undefined &&
        !account.config.apiPasswordFile?.trim() &&
        isWebAttachmentUrl(ctx.mediaUrl)
      ) {
        ctx.signal?.throwIfAborted();
        return sendNextcloudTalkMessage(
          {
            ...ctx,
            assertDirectAdapterHandoff: () => {
              ctx.signal?.throwIfAborted();
              ctx.assertDirectAdapterHandoff?.();
            },
          },
          `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}`,
        );
      }
      const { sendMediaNextcloudTalk } = await import("./outbound-media.js");
      return sendMediaNextcloudTalk(ctx);
    },
  },
});
