import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { jsonResult, readReactionParams, readStringParam } from "../runtime-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

function describeNextcloudTalkMessageTool(): ChannelMessageToolDiscovery {
  return {
    actions: ["react"],
    capabilities: [],
    schema: null,
  };
}

function resolveReactionRoomToken(params: {
  args: Record<string, unknown>;
  toolContext?: { currentChannelId?: string };
}): string {
  const roomToken =
    readStringParam(params.args, "to") ??
    readStringParam(params.args, "roomToken") ??
    readStringParam(params.args, "channelId") ??
    params.toolContext?.currentChannelId;
  if (!roomToken?.trim()) {
    throw new Error(
      "Nextcloud Talk react requires a room target. Provide to=<roomToken> or use the tool in a channel context.",
    );
  }
  return roomToken;
}

export const nextcloudTalkMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeNextcloudTalkMessageTool,
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action !== "react") {
      throw new Error(`Unsupported Nextcloud Talk action: ${action}`);
    }

    const messageIdRaw = resolveReactionMessageId({ args: params, toolContext });
    const messageId = messageIdRaw != null ? String(messageIdRaw) : "";
    if (!messageId) {
      throw new Error(
        "Nextcloud Talk react requires messageId. Provide messageId explicitly or react to the current inbound message.",
      );
    }

    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a Nextcloud Talk reaction.",
    });
    if (remove) {
      return jsonResult({
        ok: false,
        error: "Nextcloud Talk reaction removal is not supported by this adapter yet.",
      });
    }
    if (isEmpty) {
      throw new Error("Nextcloud Talk react requires emoji.");
    }

    const roomToken = resolveReactionRoomToken({
      args: params,
      toolContext: { currentChannelId: toolContext?.currentChannelId },
    });
    const account = resolveNextcloudTalkAccount({
      cfg: cfg as CoreConfig,
      accountId,
    });

    await sendReactionNextcloudTalk(roomToken, messageId, emoji, {
      accountId: account.accountId,
      cfg: cfg as CoreConfig,
    });
    return jsonResult({ ok: true, added: emoji, messageId, roomToken });
  },
};
