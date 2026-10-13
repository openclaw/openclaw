import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { getClientManager } from "./client-manager-registry.js";
import { resolveTwitchAccountContext } from "./config.js";
import { TWITCH_CHAT_MESSAGE_LIMIT } from "./constants.js";
import { sendMessageTwitchInternal } from "./send.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  OutboundDeliveryResult,
} from "./types.js";
import { normalizeTwitchChannel } from "./utils/twitch.js";

export const twitchOutbound = {
  deliveryMode: "direct",

  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      messageSendingHooks: true,
    },
  },

  // The client manager chunks after the sender strips Markdown once.
  // A core chunker would reparse literal Markdown and could erase visible text.
  textChunkLimit: TWITCH_CHAT_MESSAGE_LIMIT,

  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),

  resolveTarget: ({ to, allowFrom, mode }) => {
    const trimmed = to?.trim() ?? "";
    const allowListRaw = normalizeStringEntries(allowFrom ?? []);
    const hasWildcard = allowListRaw.includes("*");
    const allowList = allowListRaw
      .filter((entry: string) => entry !== "*")
      .map((entry: string) => normalizeTwitchChannel(entry))
      .filter((entry): entry is string => entry.length > 0);

    const normalizedTo = normalizeTwitchChannel(trimmed);
    const restricted = mode === "implicit" || mode === "heartbeat";
    if (
      normalizedTo &&
      (!restricted || hasWildcard || allowList.length === 0 || allowList.includes(normalizedTo))
    ) {
      return { ok: true, to: normalizedTo };
    }
    return {
      ok: false,
      error: new Error("Delivering to Twitch requires target <channel-name>"),
    };
  },

  sendText: async (params: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const { cfg, to, text, accountId } = params;
    const signal = (params as { signal?: AbortSignal }).signal;

    if (signal?.aborted) {
      throw new Error("Outbound delivery aborted");
    }

    const {
      account,
      accountId: normalizedAccountId,
      availableAccountIds,
      configured,
    } = resolveTwitchAccountContext(cfg, accountId);
    if (!account) {
      throw new Error(
        `Twitch account not found: ${accountId ?? normalizedAccountId}. ` +
          `Available accounts: ${availableAccountIds.join(", ") || "none"}`,
      );
    }

    const channel = to || account.channel;
    if (!channel) {
      throw new Error("No channel specified and no default channel in account config");
    }

    if (!configured) {
      throw new Error(
        `Account ${normalizedAccountId} is not properly configured. ` +
          "Required: username, clientId, and accessToken (config or env for default account).",
      );
    }
    // A target that normalizes to empty still uses the account's default channel.
    const deliveryChannel = normalizeTwitchChannel(channel) || account.channel;
    if (!deliveryChannel) {
      throw new Error("No channel specified and no default channel in account config");
    }
    const result = await sendMessageTwitchInternal({
      channel: normalizeTwitchChannel(deliveryChannel),
      text,
      cfg,
      account,
      accountId: normalizedAccountId,
      clientManager: getClientManager(normalizedAccountId),
    });

    return {
      channel: "twitch",
      ...(result.outcome ? { outcome: result.outcome } : {}),
      messageId: result.messageId,
      receipt: result.receipt,
      timestamp: Date.now(),
    };
  },

  sendMedia: async (params: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const { text, mediaUrl } = params;
    const signal = (params as { signal?: AbortSignal }).signal;

    if (signal?.aborted) {
      throw new Error("Outbound delivery aborted");
    }

    const message = mediaUrl ? `${text || ""} ${mediaUrl}`.trim() : text;

    return twitchOutbound.sendText({
      ...params,
      text: message,
    });
  },
} satisfies ChannelOutboundAdapter;

export const twitchMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "twitch",
  outbound: twitchOutbound,
});
