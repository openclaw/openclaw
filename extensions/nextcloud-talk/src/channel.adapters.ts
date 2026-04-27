import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
  type ResolvedNextcloudTalkAccount,
} from "./accounts.js";
import { sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

export const nextcloudTalkConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedNextcloudTalkAccount,
  ResolvedNextcloudTalkAccount,
  CoreConfig
>({
  sectionKey: "nextcloud-talk",
  listAccountIds: listNextcloudTalkAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveNextcloudTalkAccount),
  defaultAccountId: resolveDefaultNextcloudTalkAccountId,
  clearBaseFields: ["botSecret", "botSecretFile", "baseUrl", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({
      allowFrom,
      stripPrefixRe: /^(nextcloud-talk|nc-talk|nc):/i,
    }),
});

export const nextcloudTalkSecurityAdapter = {
  resolveDmPolicy: createScopedDmSecurityResolver<ResolvedNextcloudTalkAccount>({
    channelKey: "nextcloud-talk",
    resolvePolicy: (account) => account.config.dmPolicy,
    resolveAllowFrom: (account) => account.config.allowFrom,
    policyPathSuffix: "dmPolicy",
    normalizeEntry: (raw) =>
      normalizeLowercaseStringOrEmpty(raw.trim().replace(/^(nextcloud-talk|nc-talk|nc):/i, "")),
  }),
};

export const nextcloudTalkPairingTextAdapter = {
  idLabel: "nextcloudUserId",
  message: "OpenClaw: your access has been approved.",
  normalizeAllowEntry: createPairingPrefixStripper(/^(nextcloud-talk|nc-talk|nc):/i, (entry) =>
    normalizeLowercaseStringOrEmpty(entry),
  ),
};

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export const nextcloudTalkMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: () => ({ actions: ["react"] }),
  supportsAction: ({ action }) => action === "react",
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action !== "react") {
      throw new Error(`Nextcloud Talk action ${action} not supported`);
    }
    const roomToken =
      pickString(params.roomToken) ||
      pickString(params.threadId) ||
      pickString(params.to) ||
      pickString(params.chatId) ||
      pickString(toolContext?.currentChannelId);
    if (!roomToken) {
      throw new Error("Nextcloud Talk react requires a room token (roomToken/threadId/to).");
    }
    const messageId = pickString(params.messageId) || pickString(toolContext?.currentMessageId);
    if (!messageId) {
      throw new Error("Nextcloud Talk react requires a messageId (or current message context).");
    }
    const reaction = pickString(params.emoji) || pickString(params.reaction);
    if (!reaction) {
      throw new Error("Nextcloud Talk react requires an emoji.");
    }
    await sendReactionNextcloudTalk(roomToken, messageId, reaction, {
      accountId: accountId ?? undefined,
      cfg: cfg as CoreConfig,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Reacted ${reaction} on ${messageId}`,
        },
      ],
      details: { messageId, roomToken, reaction },
    };
  },
};
