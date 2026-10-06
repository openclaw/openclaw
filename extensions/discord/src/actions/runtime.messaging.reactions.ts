import {
  jsonResult,
  readPositiveIntegerParam,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import * as discordMessagingActionRuntime from "../send.js";
import type { DiscordMessagingActionContext } from "./runtime.messaging.shared.js";

export async function handleDiscordReactionMessagingAction(ctx: DiscordMessagingActionContext) {
  switch (ctx.action) {
    case "react": {
      if (!ctx.isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const channelId = await ctx.resolveReactionChannelId();
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
      });
      const { emoji, remove, isEmpty } = readReactionParams(ctx.params, {
        removeErrorMessage: "Emoji is required to remove a Discord reaction.",
      });
      await ctx.assertReadTargetAllowed({ channelId });
      if (isEmpty) {
        const removed = await discordMessagingActionRuntime.removeOwnReactionsDiscord(
          channelId,
          messageId,
          ctx.withReactionRuntimeOptions(),
        );
        return jsonResult({ ok: true, removed: removed.removed });
      }
      const mutate = remove
        ? discordMessagingActionRuntime.removeReactionDiscord
        : discordMessagingActionRuntime.reactMessageDiscord;
      await mutate(channelId, messageId, emoji, ctx.withReactionRuntimeOptions());
      return jsonResult({ ok: true, [remove ? "removed" : "added"]: emoji });
    }
    case "reactions": {
      if (!ctx.isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const channelId = await ctx.resolveReactionChannelId();
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
      });
      const limit = readPositiveIntegerParam(ctx.params, "limit");
      await ctx.assertReadTargetAllowed({ channelId });
      const reactions = await discordMessagingActionRuntime.fetchReactionsDiscord(
        channelId,
        messageId,
        ctx.withReactionRuntimeOptions({ limit }),
      );
      return jsonResult({ ok: true, reactions });
    }
    default:
      return undefined;
  }
}
