import type { Message } from "grammy/types";
import type { ChannelIngressContextBinding } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type {
  DmPolicy,
  OpenClawConfig,
  TelegramAccountConfig,
  TelegramGroupConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramDmAllow } from "./access-groups.js";
import { resolveTelegramAccount } from "./accounts.js";
import {
  normalizeDmAllowFromWithStore,
  resolveTelegramEffectiveDmPolicy,
  type NormalizedAllowFrom,
} from "./bot-access.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { resolveTelegramMessageTurnSettings } from "./bot-message.js";
import {
  resolveTelegramGroupAllowFromContext,
  resolveTelegramMessageThreadSpec,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import { enforceTelegramDmAccess, isTelegramDmAccessAllowed } from "./dm-access.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
  resolveTelegramEffectiveGroupPolicy,
} from "./group-access.js";
import {
  createTelegramIngressResolver,
  resolveTelegramCommandIngressAuthorization,
  resolveTelegramNativeCommandAdmission,
  resolveTelegramEventIngressAuthorization,
  telegramAllowEntries,
} from "./ingress.js";

export type TelegramEventAuthorizationMode =
  | "reaction"
  | "callback-scope"
  | "callback-allowlist"
  | "callback-runtime-allowlist";

export interface TelegramHandlerAuthorization {
  resolveTelegramEventAuthorizationContext: (params: {
    cfg: OpenClawConfig;
    chatId: number;
    isGroup: boolean;
    senderId?: string;
    threadSpec: TelegramThreadSpec;
    msg?: Message;
  }) => Promise<TelegramEventAuthorizationContext>;
  authorizeTelegramEventSender: (params: {
    chatId: number;
    chatTitle?: string;
    isGroup: boolean;
    senderId: string;
    mode: TelegramEventAuthorizationMode;
    context: TelegramEventAuthorizationContext;
  }) => Promise<boolean>;
  isTelegramModelCallbackAuthorized: (params: {
    chatId: number;
    isGroup: boolean;
    senderId: string;
    context: TelegramEventAuthorizationContext;
  }) => Promise<boolean>;
  authorizeInboundMessage: (params: {
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    senderId: string;
    requireConfiguredGroup: boolean;
    dmAccess: "challenge" | "silent";
  }) => Promise<TelegramInboundGate>;
}

export function createTelegramHandlerAuthorization({
  accountId,
  nativeCommandNames,
  bot,
  opts,
  logger,
  telegramDeps,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
}: RegisterTelegramHandlerParams): TelegramHandlerAuthorization {
  const shouldSkipGroupMessage = (
    params: Parameters<typeof shouldSkipTelegramGroupMessage>[0],
    context: TelegramEventAuthorizationContext,
  ) => shouldSkipTelegramGroupMessage(params, context, { logger, resolveGroupPolicy });

  const TELEGRAM_EVENT_AUTH_RULES: Record<
    TelegramEventAuthorizationMode,
    {
      enforceDirectAuthorization: boolean;
      enforceGroupAllowlistAuthorization: boolean;
      deniedDmReason: string;
      deniedGroupReason: string;
    }
  > = {
    reaction: {
      enforceDirectAuthorization: true,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "reaction unauthorized by dm policy/allowlist",
      deniedGroupReason: "reaction unauthorized by group allowlist",
    },
    "callback-scope": {
      enforceDirectAuthorization: false,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope",
    },
    "callback-allowlist": {
      enforceDirectAuthorization: true,
      // Group auth is already enforced by shouldSkipGroupMessage (group policy + allowlist).
      // An extra allowlist gate here would block users whose original command was authorized.
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope allowlist",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope allowlist",
    },
    "callback-runtime-allowlist": {
      enforceDirectAuthorization: true,
      enforceGroupAllowlistAuthorization: true,
      deniedDmReason: "runtime callback unauthorized by allowlist",
      deniedGroupReason: "runtime callback unauthorized by group allowlist",
    },
  };

  // Authorization owns one ingress snapshot. The agent turn intentionally
  // captures again after batching so reloads during debounce apply to execution.
  const resolveTelegramEventAuthorizationContext = async (
    params: Parameters<TelegramHandlerAuthorization["resolveTelegramEventAuthorizationContext"]>[0],
  ): Promise<TelegramEventAuthorizationContext> => {
    const authorizationCfg = params.cfg;
    const authorizationTelegramCfg = resolveTelegramAccount({
      cfg: authorizationCfg,
      accountId,
    }).config;
    const authorizationSettings = resolveTelegramMessageTurnSettings({
      accountId,
      cfg: authorizationCfg,
      telegramCfg: authorizationTelegramCfg,
      opts,
    });
    const commandAuthorizedByConfig = params.msg
      ? await resolveTelegramNativeCommandAdmission({
          msg: params.msg,
          nativeCommandNames,
          botUsername: bot.botInfo?.username ?? opts.botInfo?.username,
          cfg: authorizationCfg,
          accountId,
          dmPolicy: authorizationSettings.dmPolicy,
          isGroup: params.isGroup,
          chatId: params.chatId,
          senderId: params.senderId ?? "",
        })
      : false;
    const groupAllowContext = await resolveTelegramGroupAllowFromContext({
      cfg: authorizationCfg,
      chatId: params.chatId,
      accountId,
      dmPolicy: authorizationSettings.dmPolicy,
      allowFrom: authorizationSettings.allowFrom,
      senderId: params.senderId,
      isGroup: params.isGroup,
      threadSpec: params.threadSpec,
      groupAllowFrom: authorizationSettings.groupAllowFrom,
      skipPairingStoreRead: commandAuthorizedByConfig,
      readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
      resolveTelegramGroupConfig,
    });
    const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
      isGroup: params.isGroup,
      groupConfig: groupAllowContext.groupConfig,
      dmPolicy: authorizationSettings.dmPolicy,
    });
    return {
      cfg: authorizationCfg,
      commandAuthorizedByConfig,
      allowFrom: authorizationSettings.allowFrom,
      telegramCfg: authorizationTelegramCfg,
      dmPolicy: effectiveDmPolicy,
      ...groupAllowContext,
    };
  };

  const authorizeTelegramEventSender = async (
    params: Parameters<TelegramHandlerAuthorization["authorizeTelegramEventSender"]>[0],
  ): Promise<boolean> => {
    const { chatId, chatTitle, isGroup, senderId, mode, context } = params;
    const {
      dmPolicy,
      resolvedThreadId,
      storeAllowFrom,
      groupAllowOverride,
      effectiveGroupAllow,
      cfg: authorizationCfg,
      allowFrom: authorizationAllowFrom,
    } = context;
    const authRules = TELEGRAM_EVENT_AUTH_RULES[mode];
    const {
      enforceDirectAuthorization,
      enforceGroupAllowlistAuthorization,
      deniedDmReason,
      deniedGroupReason,
    } = authRules;
    if (shouldSkipGroupMessage({ isGroup, chatId, chatTitle, senderId }, context)) {
      return false;
    }

    if (isGroup ? enforceGroupAllowlistAuthorization : enforceDirectAuthorization) {
      // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom.
      const effectiveDmAllow = isGroup
        ? normalizeDmAllowFromWithStore({ allowFrom: [], dmPolicy })
        : (
            await resolveTelegramDmAllow({
              cfg: authorizationCfg,
              allowFrom: groupAllowOverride ?? authorizationAllowFrom,
              accountId,
              senderId,
              storeAllowFrom,
              dmPolicy,
            })
          ).effectiveAllow;
      const eventAccess = await resolveTelegramEventIngressAuthorization({
        accountId,
        dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId,
        senderId,
        effectiveDmAllow,
        effectiveGroupAllow,
        enforceGroupAuthorization: isGroup,
        eventKind: mode === "reaction" ? "reaction" : "button",
      });
      if (eventAccess.decision !== "allow") {
        const subject = isGroup
          ? "group sender"
          : eventAccess.reasonCode === "dm_policy_disabled"
            ? "direct event from"
            : "direct sender";
        logVerbose(
          `Blocked telegram ${subject} ${senderId || "unknown"} (${isGroup ? deniedGroupReason : deniedDmReason})`,
        );
        return false;
      }
    }
    return true;
  };

  const isTelegramModelCallbackAuthorized = async (
    params: Parameters<TelegramHandlerAuthorization["isTelegramModelCallbackAuthorized"]>[0],
  ): Promise<boolean> => {
    const { chatId, isGroup, senderId, context } = params;
    const cfgLocal = context.cfg;
    const { effectiveAllow: dmAllow } = await resolveTelegramDmAllow({
      cfg: cfgLocal,
      allowFrom: context.groupAllowOverride ?? context.allowFrom,
      accountId,
      senderId,
      storeAllowFrom: isGroup ? [] : context.storeAllowFrom,
      dmPolicy: context.dmPolicy,
    });
    return (
      await resolveTelegramCommandIngressAuthorization({
        accountId,
        cfg: cfgLocal,
        dmPolicy: context.dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId: context.resolvedThreadId,
        senderId,
        effectiveDmAllow: dmAllow,
        effectiveGroupAllow: context.effectiveGroupAllow,
        eventKind: "button",
      })
    ).authorized;
  };
  // Single authorization gate for every message-like update that can reach the
  // reply-chain cache or dispatch: fresh messages, edits, channel posts. Must run
  // before any cache/dedupe side effect so blocked content is never recorded.
  // dmAccess "challenge" may send a pairing reply; "silent" only decides (edits
  // must never reply).
  const authorizeInboundMessage = async (
    params: Parameters<TelegramHandlerAuthorization["authorizeInboundMessage"]>[0],
  ): Promise<TelegramInboundGate> => {
    const authorizationCfg = telegramDeps.getRuntimeConfig();
    const context = await resolveTelegramEventAuthorizationContext({
      cfg: authorizationCfg,
      msg: params.msg,
      chatId: params.chatId,
      isGroup: params.isGroup,
      senderId: params.senderId,
      threadSpec: resolveTelegramMessageThreadSpec(params.msg, params.isForum),
    });
    const {
      dmPolicy,
      resolvedThreadId,
      dmThreadId,
      storeAllowFrom,
      groupConfig,
      topicConfig,
      groupAllowOverride,
      effectiveGroupAllow,
      telegramCfg: authorizationTelegramCfg,
      allowFrom: authorizationAllowFrom,
    } = context;
    // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
    const { effectiveAllow: effectiveDmAllow } = await resolveTelegramDmAllow({
      cfg: authorizationCfg,
      allowFrom: groupAllowOverride ?? authorizationAllowFrom,
      accountId,
      senderId: params.senderId,
      storeAllowFrom,
      dmPolicy,
    });

    if (params.requireConfiguredGroup && (!groupConfig || groupConfig.enabled === false)) {
      logVerbose(`Blocked telegram channel ${params.chatId} (channel disabled)`);
      return { allowed: false };
    }

    if (
      shouldSkipGroupMessage(
        {
          isGroup: params.isGroup,
          chatId: params.chatId,
          chatTitle: params.msg.chat.title,
          senderId: params.senderId,
          commandAuthorized: context.commandAuthorizedByConfig,
        },
        context,
      )
    ) {
      return { allowed: false };
    }

    if (!params.isGroup) {
      const requireTopic =
        groupConfig && "requireTopic" in groupConfig ? groupConfig.requireTopic : undefined;
      if (requireTopic === true && dmThreadId == null) {
        logVerbose(`Blocked telegram DM ${params.chatId}: requireTopic=true but no topic present`);
        return { allowed: false };
      }
      const dmAuthorized =
        context.commandAuthorizedByConfig ||
        (params.dmAccess === "challenge"
          ? await enforceTelegramDmAccess({
              isGroup: params.isGroup,
              dmPolicy,
              msg: params.msg,
              chatId: params.chatId,
              effectiveDmAllow,
              accountId,
              bot,
              logger,
              upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
            })
          : await isTelegramDmAccessAllowed({
              dmPolicy,
              msg: params.msg,
              chatId: params.chatId,
              effectiveDmAllow,
              accountId,
            }));
      if (!dmAuthorized) {
        return { allowed: false };
      }
    }

    // The canonical context builder owns final routing after any buffering.
    // Memoize its first exact result so retries cannot mint replacement authority.
    const ingressResolver = createTelegramIngressResolver({
      accountId,
      cfg: authorizationCfg,
    });
    const groupPolicy = resolveTelegramEffectiveGroupPolicy({
      cfg: authorizationCfg,
      telegramCfg: authorizationTelegramCfg,
      groupConfig: params.isGroup ? (groupConfig as TelegramGroupConfig | undefined) : undefined,
      topicConfig,
    });
    let admittedIngress: ReturnType<typeof ingressResolver.message> | undefined;
    const resolveChannelIngress = (contextBinding: ChannelIngressContextBinding) =>
      (admittedIngress ??= ingressResolver.message({
        ...(context.commandAuthorizedByConfig
          ? {
              event: { kind: "native-command", authMode: "command", mayPair: false } as const,
              command: { commandOwnerAllowFrom: [params.senderId] },
            }
          : {}),
        subject: { stableId: params.senderId },
        conversation: {
          kind: params.isGroup ? "group" : "direct",
          id: String(params.chatId),
          ...(params.isGroup && resolvedThreadId != null
            ? { parentId: String(params.chatId) }
            : {}),
          ...(resolvedThreadId != null ? { threadId: String(resolvedThreadId) } : {}),
        },
        contextBinding,
        dmPolicy,
        groupPolicy,
        allowFrom: telegramAllowEntries(effectiveDmAllow),
        groupAllowFrom: telegramAllowEntries(effectiveGroupAllow),
      }));
    return { allowed: true, context, effectiveDmAllow, resolveChannelIngress };
  };

  return {
    resolveTelegramEventAuthorizationContext,
    authorizeTelegramEventSender,
    isTelegramModelCallbackAuthorized,
    authorizeInboundMessage,
  };
}

type TelegramEventAuthorizationContext = Awaited<
  ReturnType<typeof resolveTelegramGroupAllowFromContext>
> & {
  commandAuthorizedByConfig: boolean;
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  dmPolicy: DmPolicy;
};

type TelegramInboundGate =
  | { allowed: false }
  | {
      allowed: true;
      context: TelegramEventAuthorizationContext;
      effectiveDmAllow: NormalizedAllowFrom;
      resolveChannelIngress: (
        contextBinding: ChannelIngressContextBinding,
      ) => ReturnType<ReturnType<typeof createTelegramIngressResolver>["message"]>;
    };

function shouldSkipTelegramGroupMessage(
  params: {
    isGroup: boolean;
    chatId: string | number;
    chatTitle?: string;
    senderId: string;
    commandAuthorized?: boolean;
  },
  context: TelegramEventAuthorizationContext,
  runtime: Pick<RegisterTelegramHandlerParams, "logger" | "resolveGroupPolicy">,
): boolean {
  const {
    resolvedThreadId,
    effectiveGroupAllow,
    hasGroupAllowOverride,
    groupConfig,
    topicConfig,
    cfg,
    telegramCfg,
  } = context;
  const { isGroup, chatId, chatTitle, senderId } = params;
  const baseAccess = evaluateTelegramGroupBaseAccess({
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    enforceAllowOverride: true,
    requireSenderForAllowOverride: true,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
      return true;
    }
    if (baseAccess.reason === "topic-disabled") {
      logVerbose(
        `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
      );
      return true;
    }
    logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`);
    return true;
  }
  if (!isGroup) {
    return false;
  }
  const policyAccess = evaluateTelegramGroupPolicyAccess({
    isGroup,
    chatId,
    cfg,
    telegramCfg,
    topicConfig,
    groupConfig,
    effectiveGroupAllow,
    senderId,
    resolveGroupPolicy: runtime.resolveGroupPolicy,
    enforceAllowlistAuthorization: !params.commandAuthorized,
    allowEmptyAllowlistEntries: false,
  });
  if (policyAccess.allowed) {
    return false;
  }
  if (policyAccess.reason === "group-policy-disabled") {
    logVerbose("Blocked telegram group message (groupPolicy: disabled)");
    return true;
  }
  if (policyAccess.reason === "group-policy-allowlist-no-sender") {
    logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
    return true;
  }
  if (policyAccess.reason === "group-policy-allowlist-empty") {
    logVerbose(
      "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
    );
    return true;
  }
  if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
    logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
    return true;
  }
  runtime.logger.info(
    { chatId, title: chatTitle, reason: "not-allowed" },
    "skipping group message",
  );
  return true;
}
