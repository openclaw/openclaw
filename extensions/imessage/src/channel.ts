import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { formatTrimmedAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
  type MessageReceiptPartKind,
  sanitizeForPlainText,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { buildOutboundBaseSessionKey } from "openclaw/plugin-sdk/routing";
import {
  collectStatusIssuesFromLastError,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import { imessageMessageActions } from "./actions.js";
import {
  imessageApprovalCapability,
  shouldSuppressLocalIMessageExecApprovalPrompt,
} from "./approval-native.js";
import { normalizeDirectChatIdentifier, resolveIMessageDirectChatService } from "./chat-context.js";
import { createIMessageConversationBindingManagerV2 } from "./conversation-bindings.js";
import {
  matchIMessageAcpConversation,
  normalizeIMessageAcpConversationId,
  resolveIMessageConversationIdFromTarget,
} from "./conversation-id.js";
import { imessageDoctor } from "./doctor.js";
import {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./group-policy.js";
import {
  sanitizeIMessageFinalOutboundText,
  sanitizeOutboundText,
} from "./monitor/sanitize-outbound.js";
import { normalizeIMessageMessagingTarget } from "./normalize.js";
import type { IMessageProbe } from "./probe.js";
import { imessageSetupContract } from "./setup-core.js";
import {
  createIMessagePluginBase,
  imessageSecurityAdapter,
  imessageSetupWizard,
} from "./shared.js";
import { isIMessagePhoneLikeHandle } from "./target-identifiers.js";
import {
  inferIMessageTargetChatType,
  looksLikeIMessageExplicitTargetId,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

const loadIMessageChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));
const loadIMessageChatLookup = createLazyRuntimeModule(() => import("./chat-lookup.js"));

type IMessageMessageContextExtras = {
  deps?: { [channelId: string]: unknown };
  conversationReadOrigin?: "delegated" | "direct-operator";
};

type IMessageOutboundContext = Omit<
  Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0],
  "onDeliveryResult"
>;
type IMessageOutboundOptions = Pick<
  Parameters<Awaited<ReturnType<typeof loadIMessageChannelRuntime>>["sendIMessageOutbound"]>[0],
  "conversationReadOrigin" | "onDeliveryResult"
>;

async function sendIMessageOutbound(
  ctx: IMessageOutboundContext,
  kind: "text" | "media",
  options: IMessageOutboundOptions = {},
) {
  return await (
    await loadIMessageChannelRuntime()
  ).sendIMessageOutbound({
    cfg: ctx.cfg,
    to: ctx.to,
    text: ctx.text,
    accountId: ctx.accountId ?? undefined,
    deps: ctx.deps,
    replyToId: ctx.replyToId ?? undefined,
    assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    ...options,
    ...(kind === "media"
      ? {
          mediaUrl: ctx.mediaUrl,
          mediaAccess: ctx.mediaAccess,
          mediaLocalRoots: ctx.mediaLocalRoots,
          mediaReadFile: ctx.mediaReadFile,
          audioAsVoice: ctx.audioAsVoice,
        }
      : {}),
  });
}

function toIMessageMessageSendResult(
  result: {
    messageId?: string;
    meta?: Record<string, unknown>;
    receipt?: ChannelMessageSendResult["receipt"];
  },
  kind: MessageReceiptPartKind,
  replyToId?: string | null,
): ChannelMessageSendResult & { meta?: Record<string, unknown> } {
  const receipt =
    result.receipt ??
    createMessageReceiptFromOutboundResults({
      results: result.messageId ? [{ channel: "imessage", messageId: result.messageId }] : [],
      kind,
      ...(replyToId ? { replyToId } : {}),
    });
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
    ...(result.meta && Object.keys(result.meta).length > 0 ? { meta: result.meta } : {}),
  };
}

const loadIMessageApprovalReactionsModule = createLazyRuntimeModule(
  () => import("./approval-reactions.js"),
);

const imessageMessageAdapter = defineChannelMessageAdapter({
  id: "imessage",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => {
      const result = await sendIMessageOutbound(ctx, "text", {
        conversationReadOrigin: (ctx as typeof ctx & IMessageMessageContextExtras)
          .conversationReadOrigin,
      });
      return toIMessageMessageSendResult(result, "text", ctx.replyToId);
    },
    media: async (ctx) => {
      const result = await sendIMessageOutbound(ctx, "media", {
        conversationReadOrigin: (ctx as typeof ctx & IMessageMessageContextExtras)
          .conversationReadOrigin,
        ...(ctx.onDeliveryResult
          ? {
              onDeliveryResult: async (acceptedResult) => {
                await ctx.onDeliveryResult?.(
                  toIMessageMessageSendResult(
                    acceptedResult,
                    ctx.audioAsVoice ? "voice" : "media",
                    ctx.replyToId,
                  ),
                );
              },
            }
          : {}),
      });
      return toIMessageMessageSendResult(
        result,
        ctx.audioAsVoice ? "voice" : "media",
        ctx.replyToId,
      );
    },
  },
});

function isCanonicalIMessageDirectHandle(raw: string, normalized: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || !normalized) {
    return false;
  }
  // Inbound DMs key sessions by normalized phone number or email. Names and
  // other bridge aliases can deliver, but cannot prove the reply identity.
  if (normalized.startsWith("+")) {
    return isIMessagePhoneLikeHandle(trimmed);
  }
  return /^[^\s@<>()[\]`]+@[^\s@<>()[\]`]+\.[^\s@<>()[\]`]+$/.test(trimmed);
}

async function resolveIMessageConversationTarget(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  accountId?: string | null;
  target: string;
}) {
  let parsed = parseIMessageTarget(params.target);
  const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.accountId });
  const deliveryTarget = parsed.kind === "handle" ? undefined : params.target;
  if (parsed.kind !== "handle") {
    const chat = await (
      await loadIMessageChatLookup()
    ).resolveIMessageChat({
      target: parsed,
      options: {
        cliPath: account.config.cliPath?.trim() || "imsg",
        dbPath: account.config.dbPath,
        remoteHost: account.config.remoteHost,
      },
      conversationReadOrigin: "delegated",
    });
    if (!chat) {
      return null;
    }
    const configuredGroup = resolveChannelGroupPolicy({
      cfg: params.cfg,
      channel: "imessage",
      accountId: account.accountId,
      groupId: String(chat.id),
    }).groupConfig;
    const chatType = configuredGroup
      ? "group"
      : inferIMessageTargetChatType(`chat_guid:${chat.guid}`);
    if (!chatType) {
      return null;
    }
    if (chatType === "group") {
      return {
        accountId: account.accountId,
        peer: { kind: "group" as const, id: String(chat.id) },
        from: `imessage:group:${chat.id}`,
        to: params.target,
        recipientSessionExact: false,
      };
    }
    parsed = {
      kind: "handle",
      to: normalizeDirectChatIdentifier(chat.guid),
      service: resolveIMessageDirectChatService(account.config.service, chat.guid) ?? "auto",
      serviceExplicit: true,
    };
  }
  const handle = normalizeIMessageHandle(parsed.to);
  if (!handle) {
    return null;
  }
  const service =
    resolveIMessageDirectChatService(
      parsed.serviceExplicit ? parsed.service : account.config.service,
    ) ?? "auto";
  const from = `${service}:${handle}`;
  return {
    accountId: account.accountId,
    peer: { kind: "direct" as const, id: handle },
    from,
    to: deliveryTarget ?? from,
    recipientSessionExact: isCanonicalIMessageDirectHandle(parsed.to, handle),
  };
}

async function resolveIMessageOutboundSessionRoute(
  params: Parameters<typeof resolveIMessageConversationTarget>[0] & { agentId: string },
) {
  const target = await resolveIMessageConversationTarget(params);
  if (!target) {
    return null;
  }
  const { accountId, ...route } = target;
  const baseSessionKey = buildOutboundBaseSessionKey({
    ...params,
    accountId,
    channel: "imessage",
    peer: route.peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    ...route,
    chatType: route.peer.kind,
  };
}

export const imessagePlugin: ChannelPlugin<ResolvedIMessageAccount, IMessageProbe, unknown, 2> =
  createChatChannelPlugin<ResolvedIMessageAccount, IMessageProbe, unknown, 2>({
    base: {
      ...createIMessagePluginBase({
        setupWizard: imessageSetupWizard,
        setupContract: imessageSetupContract,
      }),
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "imessage",
        resolveAccount: resolveIMessageAccount,
        normalize: ({ values }) => formatTrimmedAllowFromEntries(values),
        resolveDmAllowFrom: (account) => account.config.allowFrom,
        resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
        resolveDmPolicy: (account) => account.config.dmPolicy,
        resolveGroupPolicy: (account) => account.config.groupPolicy,
      }),
      groups: {
        resolveRequireMention: resolveIMessageGroupRequireMention,
        resolveToolPolicy: resolveIMessageGroupToolPolicy,
      },
      agentPrompt: {
        messageToolHints: () => [
          "- iMessage current conversation: omit target, to, chatId, chatGuid, and chatIdentifier. OpenClaw resolves the trusted current chat server-side; never copy a redacted display value such as `***` into message actions.",
        ],
      },
      doctor: imessageDoctor,
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        bindingStore: "adapter",
        createManager: ({ cfg, accountId }) =>
          createIMessageConversationBindingManagerV2({
            cfg,
            accountId: accountId ?? undefined,
          }),
      },
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeIMessageAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId }) =>
          matchIMessageAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
          }),
        resolveCommandConversation: ({ originatingTo, commandTo, fallbackTo }) => {
          const conversationId =
            resolveIMessageConversationIdFromTarget(originatingTo ?? "") ??
            resolveIMessageConversationIdFromTarget(commandTo ?? "") ??
            resolveIMessageConversationIdFromTarget(fallbackTo ?? "");
          return conversationId ? { conversationId } : null;
        },
      },
      messaging: {
        normalizeTarget: normalizeIMessageMessagingTarget,
        inferTargetChatType: ({ to }) => inferIMessageTargetChatType(to),
        resolveOutboundSessionRoute: resolveIMessageOutboundSessionRoute,
        targetResolver: {
          looksLikeId: looksLikeIMessageExplicitTargetId,
          hint: "<phone|email|chat_id:ID|auto:contact|imessage:contact|sms:contact>",
          resolveTarget: async ({ cfg, accountId, input }) => {
            const to = normalizeIMessageMessagingTarget(input);
            if (!to) {
              return null;
            }
            const target = await resolveIMessageConversationTarget({ cfg, accountId, target: to });
            if (!target) {
              return null;
            }
            const parsed = parseIMessageTarget(to);
            const display =
              parsed.kind === "handle" &&
              !isCanonicalIMessageDirectHandle(parsed.to, normalizeIMessageHandle(parsed.to))
                ? parsed.to.trim()
                : undefined;
            return {
              to,
              kind: target.peer.kind === "direct" ? "user" : "group",
              ...(display ? { display } : {}),
              source: "normalized" as const,
            };
          },
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedIMessageAccount, IMessageProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          cliPath: null,
          dbPath: null,
        }),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("imessage", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildPassiveProbedChannelStatusSummary(snapshot, {
            cliPath: snapshot.cliPath ?? null,
            dbPath: snapshot.dbPath ?? null,
          }),
        probeAccount: async ({ account, timeoutMs }) =>
          await (
            await loadIMessageChannelRuntime()
          ).probeIMessageAccount({
            timeoutMs,
            cliPath: account.config.cliPath,
            dbPath: account.config.dbPath,
            ...(account.config.remoteHost ? { remoteHost: account.config.remoteHost } : {}),
          }),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            cliPath: runtime?.cliPath ?? account.config.cliPath ?? null,
            dbPath: runtime?.dbPath ?? account.config.dbPath ?? null,
          },
        }),
        resolveAccountState: ({ enabled }) => (enabled ? "enabled" : "disabled"),
      }),
      gateway: {
        apiVersion: 2,
        startAccount: async (ctx) => {
          const conversationBindings = createIMessageConversationBindingManagerV2({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
          });
          try {
            return await (await loadIMessageChannelRuntime()).startIMessageGatewayAccount(ctx);
          } finally {
            conversationBindings.stop();
          }
        },
      },
      message: imessageMessageAdapter,
      actions: imessageMessageActions,
      approvalCapability: imessageApprovalCapability,
    },
    pairing: {
      text: {
        idLabel: "imessageSenderId",
        message: PAIRING_APPROVED_MESSAGE,
        notify: async (params) => {
          await (
            await loadIMessageChannelRuntime()
          ).sendIMessageOutbound({
            ...params,
            to: params.id,
            text: params.message,
          });
        },
      },
    },
    security: imessageSecurityAdapter,
    threading: {
      resolveReplyTransport: ({
        cfg,
        accountId,
        replyToId,
        currentMessageId,
        replyToCurrent,
        replyToIsExplicit,
        replyDelivery,
      }) => {
        const account = resolveIMessageAccount({ cfg, accountId });
        if (account.config.actions?.reply === false) {
          return { replyToId: null };
        }
        const existingReplyToId = normalizeOptionalString(replyToId);
        const explicitCurrentReply = replyToIsExplicit === true && replyToCurrent === true;
        // Queued replies carry the originating message separately from explicit reply targets.
        const implicitReplyToId =
          replyToCurrent === false ||
          (replyDelivery?.replyToMode === "off" && !explicitCurrentReply)
            ? undefined
            : normalizeOptionalString(currentMessageId);
        return {
          replyToId: existingReplyToId ?? implicitReplyToId ?? null,
          ...(!existingReplyToId && !explicitCurrentReply && implicitReplyToId
            ? { replyToIdSource: "implicit" as const }
            : {}),
        };
      },
    },
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: chunkMarkdownText,
        chunkerMode: "markdown",
        textChunkLimit: 4000,
        // Native formatting consumes Markdown ranges, so preserve bold and strike semantics.
        sanitizeText: ({ text }) =>
          sanitizeForPlainText(sanitizeIMessageFinalOutboundText(sanitizeOutboundText(text)).text, {
            style: "markdown",
          }),
        shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload, hint }) =>
          shouldSuppressLocalIMessageExecApprovalPrompt({ cfg, accountId, payload, hint }),
        beforeDeliverPayload: async ({ payload, hint }) => {
          if (hint?.kind !== "approval-pending") {
            return;
          }
          const prepared = (
            await loadIMessageApprovalReactionsModule()
          ).addIMessageApprovalReactionHintToStructuredPayload({
            payload,
            approvalKind: hint.approvalKind,
          });
          if (prepared) {
            Object.assign(payload, prepared);
          }
        },
        afterDeliverPayload: async ({ cfg, target, payload, results }) => {
          const accountId = resolveIMessageAccount({ cfg, accountId: target.accountId }).accountId;
          const delivery = { accountId, target, payload, results };
          await (
            await loadIMessageApprovalReactionsModule()
          ).registerIMessageApprovalReactionTargetForDeliveredPayload(delivery);
        },
        deliveryCapabilities: {
          durableFinal: {
            text: true,
            media: true,
            replyTo: true,
            messageSendingHooks: true,
          },
        },
      },
      attachedResults: {
        channel: "imessage",
        sendText: (ctx) => sendIMessageOutbound(ctx, "text"),
        sendMedia: (ctx) =>
          sendIMessageOutbound(
            ctx,
            "media",
            ctx.onDeliveryResult
              ? {
                  onDeliveryResult: async (result) => {
                    await ctx.onDeliveryResult?.({
                      channel: "imessage",
                      ...toIMessageMessageSendResult(
                        result,
                        ctx.audioAsVoice ? "voice" : "media",
                        ctx.replyToId,
                      ),
                      messageId: result.messageId,
                    });
                  },
                }
              : {},
          ),
      },
    },
  });
