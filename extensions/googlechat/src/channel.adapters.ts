import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import { identityEntryAuthenticationClassifier } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendTextContext,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createAllowlistProviderOpenWarningCollector,
  createConditionalWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createChannelDirectoryAdapter,
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleChatAccount, type ResolvedGoogleChatAccount } from "./accounts.js";
import { shouldSuppressGoogleChatManualExecApprovalFollowupPayload } from "./approval-card-actions.js";
import { formatGoogleChatAllowFromEntry } from "./channel-base.js";
import {
  formatGoogleChatTextChunks,
  GOOGLE_CHAT_FORMAT_PROFILE,
  sanitizeGoogleChatText,
} from "./format.js";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";
import { googleChatIngressIdentity } from "./ingress-identity.js";
import {
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
  resolveGoogleChatOutboundSpace,
} from "./targets.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

type GoogleChatTextSendContext = Pick<
  ChannelMessageSendTextContext,
  | "cfg"
  | "to"
  | "text"
  | "accountId"
  | "replyToId"
  | "threadId"
  | "assertDirectAdapterHandoff"
  | "onPlatformSendDispatch"
>;

const collectGoogleChatGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedGoogleChatAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.googlechat !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "Google Chat spaces",
      openBehavior: "allows any space to trigger (mention-gated)",
      remediation:
        'Set channels.googlechat.groupPolicy="allowlist" and configure channels.googlechat.groups',
    },
  });
const collectGoogleChatOpenGroupFindings = createConditionalWarningCollector.findings({
  collectWarnings: collectGoogleChatGroupPolicyWarnings,
  checkId: "channels.googlechat.groups.open",
  severity: "warn",
  title: "Google Chat security warning",
});

const collectGoogleChatSecurityWarnings = (params: {
  cfg: OpenClawConfig;
  account: ResolvedGoogleChatAccount;
}) => [
  ...collectGoogleChatOpenGroupFindings(params),
  ...(params.account.config.dmPolicy === "open"
    ? [
        '- Google Chat DMs are open to anyone. Set channels.googlechat.dmPolicy="pairing" or "allowlist".',
      ]
    : []),
];

export const googlechatGroupsAdapter = {
  resolveRequireMention: resolveGoogleChatGroupRequireMention,
};

export const googlechatDirectoryAdapter = createChannelDirectoryAdapter({
  listPeers: async (params) =>
    listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedGoogleChatAccount>({
      ...params,
      resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
      resolveAllowFrom: (account) => account.config.allowFrom,
      normalizeId: (entry) => normalizeGoogleChatTarget(entry) ?? entry,
    }),
  listGroups: async (params) =>
    listResolvedDirectoryGroupEntriesFromMapKeys<ResolvedGoogleChatAccount>({
      ...params,
      resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
      resolveGroups: (account) => account.config.groups,
    }),
});

export const googlechatSecurityAdapter = {
  dm: {
    channelKey: "googlechat",
    resolvePolicy: (account: ResolvedGoogleChatAccount) => account.config.dmPolicy,
    resolveAllowFrom: (account: ResolvedGoogleChatAccount) => account.config.allowFrom,
    allowFromPathSuffix: "",
    classifyEntryAuthentication: identityEntryAuthenticationClassifier(googleChatIngressIdentity),
    normalizeEntry: (raw: string) => formatGoogleChatAllowFromEntry(raw),
  },
  collectWarnings: collectGoogleChatSecurityWarnings,
};

export const googlechatThreadingAdapter = {
  scopedAccountReplyToMode: {
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveGoogleChatAccount({ cfg, accountId }),
    resolveReplyToMode: (account: ResolvedGoogleChatAccount, _chatType?: string | null) =>
      account.config.replyToMode,
    fallback: "off" as const,
  },
  buildToolContext: ({
    cfg,
    accountId,
    context,
    hasRepliedRef,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    context: ChannelThreadingContext;
    hasRepliedRef?: { value: boolean };
  }): ChannelThreadingToolContext => {
    const currentChannelId = normalizeGoogleChatTarget(context.To);
    const replyToId =
      normalizeOptionalString(context.ReplyToIdFull) ?? normalizeOptionalString(context.ReplyToId);

    return {
      currentChannelId,
      currentMessageId: replyToId,
      currentThreadTs: replyToId,
      replyToMode: resolveGoogleChatAccount({ cfg, accountId }).config.replyToMode,
      hasRepliedRef,
    };
  },
};

export const googlechatPairingTextAdapter = {
  idLabel: "googlechatUserId",
  message: PAIRING_APPROVED_MESSAGE,
  normalizeAllowEntry: (entry: string) => formatGoogleChatAllowFromEntry(entry),
  notify: async ({
    cfg,
    id,
    message,
    accountId,
  }: {
    cfg: OpenClawConfig;
    id: string;
    message: string;
    accountId?: string | null;
  }) => {
    const account = resolveGoogleChatAccount({ cfg, accountId });
    if (account.credentialSource === "none" || account.tokenStatus === "configured_unavailable") {
      return;
    }
    const user = normalizeGoogleChatTarget(id) ?? id;
    const target = isGoogleChatUserTarget(user) ? user : `users/${user}`;
    const space = await resolveGoogleChatOutboundSpace({ account, target });
    const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
    await sendGoogleChatMessage({
      account,
      space,
      text: message,
    });
  },
};

export const googlechatOutboundAdapter = {
  base: {
    deliveryMode: "direct" as const,
    chunker: (text: string, limit: number) => formatGoogleChatTextChunks(text, limit),
    chunkerMode: "markdown" as const,
    textChunkLimit: GOOGLE_CHAT_FORMAT_PROFILE.chunk.limit,
    sanitizeText: ({ text }: { text: string }) => sanitizeGoogleChatText(text),
    normalizePayload: ({ payload }: { payload: ReplyPayload }) =>
      shouldSuppressGoogleChatManualExecApprovalFollowupPayload(payload) ? null : payload,
    resolveTarget: ({ to }: { to?: string }) => {
      const normalized = normalizeGoogleChatTarget(normalizeOptionalString(to));
      return normalized
        ? { ok: true as const, to: normalized }
        : {
            ok: false as const,
            error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>"),
          };
    },
  },
  attachedResults: {
    channel: "googlechat" as const,
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      replyToId,
      threadId,
      assertDirectAdapterHandoff,
      onPlatformSendDispatch,
    }: GoogleChatTextSendContext) => {
      const account = resolveGoogleChatAccount({
        cfg,
        accountId,
      });
      const space = await resolveGoogleChatOutboundSpace({
        account,
        target: to,
        assertDirectAdapterHandoff,
      });
      const thread =
        typeof threadId === "number" ? String(threadId) : (threadId ?? replyToId ?? undefined);
      const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread,
        assertDirectAdapterHandoff,
        onPlatformSendDispatch,
      });
      const messageId = result?.messageName ?? "";
      const receiptMessageId = messageId.trim();
      return {
        messageId,
        chatId: space,
        receipt: createMessageReceiptFromOutboundResults({
          results: receiptMessageId
            ? [
                {
                  channel: "googlechat",
                  messageId: receiptMessageId,
                  chatId: space,
                  conversationId: space,
                },
              ]
            : [],
          threadId: result?.threadName ?? thread,
          kind: "text",
        }),
      };
    },
  },
};

export const googlechatMessageAdapter = defineChannelMessageAdapter({
  id: "googlechat",
  durableFinal: {
    capabilities: {
      text: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: googlechatOutboundAdapter.attachedResults.sendText,
  },
});
