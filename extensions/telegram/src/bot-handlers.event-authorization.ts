import type {
  DmPolicy,
  OpenClawConfig,
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramAccount } from "./accounts.js";
import {
  normalizeDmAllowFromWithStore,
  resolveTelegramEffectiveDmPolicy,
  type NormalizedAllowFrom,
} from "./bot-access.js";
import { resolveTelegramMessageTurnSettings } from "./bot-message.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  isTelegramCommandsAllowFromConfigured,
  resolveTelegramCommandAuthorization,
  resolveTelegramGroupAllowFromContext,
} from "./bot/helpers.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import {
  resolveTelegramCommandIngressAuthorization,
  resolveTelegramEventIngressAuthorization,
} from "./ingress.js";

type TelegramGroupAllowContext = Awaited<ReturnType<typeof resolveTelegramGroupAllowFromContext>>;

export type TelegramEventAuthorizationMode = "reaction" | "callback-scope" | "callback-allowlist";

export type TelegramEventAuthorizationContext = TelegramGroupAllowContext & {
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  allowFrom: ReturnType<typeof resolveTelegramMessageTurnSettings>["allowFrom"];
  dmPolicy: DmPolicy;
};

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
    // Group messages already passed group policy and allowlist authorization.
    enforceGroupAllowlistAuthorization: false,
    deniedDmReason: "callback unauthorized by inlineButtonsScope allowlist",
    deniedGroupReason: "callback unauthorized by inlineButtonsScope allowlist",
  },
};

type TelegramGroupMessageGateParams = {
  isGroup: boolean;
  chatId: string | number;
  chatTitle?: string;
  resolvedThreadId?: number;
  senderId: string;
  senderUsername: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  hasGroupAllowOverride: boolean;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
};

export function createTelegramEventAuthorizationRuntime(
  params: Pick<
    RegisterTelegramHandlerParams,
    | "accountId"
    | "logger"
    | "opts"
    | "resolveGroupPolicy"
    | "resolveTelegramGroupConfig"
    | "telegramDeps"
  >,
) {
  const { accountId, logger, opts, resolveGroupPolicy, resolveTelegramGroupConfig, telegramDeps } =
    params;

  const shouldSkipGroupMessage = (gate: TelegramGroupMessageGateParams) => {
    const baseAccess = evaluateTelegramGroupBaseAccess({
      isGroup: gate.isGroup,
      groupConfig: gate.groupConfig,
      topicConfig: gate.topicConfig,
      hasGroupAllowOverride: gate.hasGroupAllowOverride,
      effectiveGroupAllow: gate.effectiveGroupAllow,
      senderId: gate.senderId,
      senderUsername: gate.senderUsername,
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });
    if (!baseAccess.allowed) {
      if (baseAccess.reason === "group-disabled") {
        logVerbose(`Blocked telegram group ${gate.chatId} (group disabled)`);
        return true;
      }
      if (baseAccess.reason === "topic-disabled") {
        logVerbose(
          `Blocked telegram topic ${gate.chatId} (${gate.resolvedThreadId ?? "unknown"}) (topic disabled)`,
        );
        return true;
      }
      logVerbose(
        `Blocked telegram group sender ${gate.senderId || "unknown"} (group allowFrom override)`,
      );
      return true;
    }
    if (!gate.isGroup) {
      return false;
    }
    const policyAccess = evaluateTelegramGroupPolicyAccess({
      isGroup: gate.isGroup,
      chatId: gate.chatId,
      cfg: gate.cfg,
      telegramCfg: gate.telegramCfg,
      topicConfig: gate.topicConfig,
      groupConfig: gate.groupConfig,
      effectiveGroupAllow: gate.effectiveGroupAllow,
      senderId: gate.senderId,
      senderUsername: gate.senderUsername,
      resolveGroupPolicy,
      enforcePolicy: true,
      useTopicAndGroupOverrides: true,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });
    if (policyAccess.allowed) {
      return false;
    }
    if (policyAccess.reason === "group-policy-disabled") {
      logVerbose("Blocked telegram group message (groupPolicy: disabled)");
    } else if (policyAccess.reason === "group-policy-allowlist-no-sender") {
      logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
    } else if (policyAccess.reason === "group-policy-allowlist-empty") {
      logVerbose(
        "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
      );
    } else if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
      logVerbose(`Blocked telegram group message from ${gate.senderId} (groupPolicy: allowlist)`);
    } else {
      logger.info(
        { chatId: gate.chatId, title: gate.chatTitle, reason: "not-allowed" },
        "skipping group message",
      );
    }
    return true;
  };

  const resolveContext = async (input: {
    cfg: OpenClawConfig;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    senderId?: string;
    messageThreadId?: number;
  }): Promise<TelegramEventAuthorizationContext> => {
    const telegramCfg = resolveTelegramAccount({ cfg: input.cfg, accountId }).config;
    const settings = resolveTelegramMessageTurnSettings({
      accountId,
      cfg: input.cfg,
      telegramCfg,
      opts,
    });
    const groupContext = await resolveTelegramGroupAllowFromContext({
      cfg: input.cfg,
      chatId: input.chatId,
      accountId,
      dmPolicy: settings.dmPolicy,
      allowFrom: settings.allowFrom,
      senderId: input.senderId,
      isGroup: input.isGroup,
      isForum: input.isForum,
      messageThreadId: input.messageThreadId,
      groupAllowFrom: settings.groupAllowFrom,
      readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
      resolveTelegramGroupConfig,
    });
    return {
      cfg: input.cfg,
      allowFrom: settings.allowFrom,
      telegramCfg,
      dmPolicy: resolveTelegramEffectiveDmPolicy({
        isGroup: input.isGroup,
        groupConfig: groupContext.groupConfig,
        dmPolicy: settings.dmPolicy,
      }),
      ...groupContext,
    };
  };

  const authorizeSender = async (input: {
    chatId: number;
    chatTitle?: string;
    isGroup: boolean;
    senderId: string;
    senderUsername: string;
    mode: TelegramEventAuthorizationMode;
    context: TelegramEventAuthorizationContext;
  }): Promise<boolean> => {
    const context = input.context;
    const rules = TELEGRAM_EVENT_AUTH_RULES[input.mode];
    if (
      shouldSkipGroupMessage({
        isGroup: input.isGroup,
        chatId: input.chatId,
        chatTitle: input.chatTitle,
        resolvedThreadId: context.resolvedThreadId,
        senderId: input.senderId,
        senderUsername: input.senderUsername,
        effectiveGroupAllow: context.effectiveGroupAllow,
        hasGroupAllowOverride: context.hasGroupAllowOverride,
        groupConfig: context.groupConfig,
        topicConfig: context.topicConfig,
        cfg: context.cfg,
        telegramCfg: context.telegramCfg,
      })
    ) {
      return false;
    }

    if (!input.isGroup && rules.enforceDirectAuthorization) {
      const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
        cfg: context.cfg,
        allowFrom: context.groupAllowOverride ?? context.allowFrom,
        accountId,
        senderId: input.senderId,
      });
      const eventAccess = await resolveTelegramEventIngressAuthorization({
        accountId,
        dmPolicy: context.dmPolicy,
        isGroup: input.isGroup,
        chatId: input.chatId,
        resolvedThreadId: context.resolvedThreadId,
        senderId: input.senderId,
        effectiveDmAllow: normalizeDmAllowFromWithStore({
          allowFrom: expandedAllowFrom,
          storeAllowFrom: context.storeAllowFrom,
          dmPolicy: context.dmPolicy,
        }),
        effectiveGroupAllow: context.effectiveGroupAllow,
        enforceGroupAuthorization: false,
        eventKind: input.mode === "reaction" ? "reaction" : "button",
      });
      if (eventAccess.decision !== "allow") {
        const label =
          eventAccess.reasonCode === "dm_policy_disabled" ? "direct event" : "direct sender";
        logVerbose(
          `Blocked telegram ${label} from ${input.senderId || "unknown"} (${rules.deniedDmReason})`,
        );
        return false;
      }
    }
    if (input.isGroup && rules.enforceGroupAllowlistAuthorization) {
      const eventAccess = await resolveTelegramEventIngressAuthorization({
        accountId,
        dmPolicy: context.dmPolicy,
        isGroup: input.isGroup,
        chatId: input.chatId,
        resolvedThreadId: context.resolvedThreadId,
        senderId: input.senderId,
        effectiveDmAllow: normalizeDmAllowFromWithStore({
          allowFrom: [],
          dmPolicy: context.dmPolicy,
        }),
        effectiveGroupAllow: context.effectiveGroupAllow,
        enforceGroupAuthorization: true,
        eventKind: input.mode === "reaction" ? "reaction" : "button",
      });
      if (eventAccess.decision !== "allow") {
        logVerbose(
          `Blocked telegram group sender ${input.senderId || "unknown"} (${rules.deniedGroupReason})`,
        );
        return false;
      }
    }
    return true;
  };

  const isModelCallbackAuthorized = async (input: {
    chatId: number;
    isGroup: boolean;
    senderId: string;
    senderUsername: string;
    context: TelegramEventAuthorizationContext;
  }): Promise<boolean> => {
    const context = input.context;
    if (isTelegramCommandsAllowFromConfigured(context.cfg)) {
      return resolveTelegramCommandAuthorization({
        cfg: context.cfg,
        accountId,
        chatId: input.chatId,
        isGroup: input.isGroup,
        resolvedThreadId: context.resolvedThreadId,
        senderId: input.senderId,
        senderUsername: input.senderUsername,
      }).isAuthorizedSender;
    }
    const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
      cfg: context.cfg,
      allowFrom: context.groupAllowOverride ?? context.allowFrom,
      accountId,
      senderId: input.senderId,
    });
    const dmAllow = normalizeDmAllowFromWithStore({
      allowFrom: expandedAllowFrom,
      storeAllowFrom: input.isGroup ? [] : context.storeAllowFrom,
      dmPolicy: context.dmPolicy,
    });
    return (
      await resolveTelegramCommandIngressAuthorization({
        accountId,
        cfg: context.cfg,
        dmPolicy: context.dmPolicy,
        isGroup: input.isGroup,
        chatId: input.chatId,
        resolvedThreadId: context.resolvedThreadId,
        senderId: input.senderId,
        effectiveDmAllow: dmAllow,
        effectiveGroupAllow: context.effectiveGroupAllow,
        ownerAccess: { ownerList: [], senderIsOwner: false },
        eventKind: "button",
      })
    ).authorized;
  };

  return { authorizeSender, isModelCallbackAuthorized, resolveContext };
}

export type TelegramEventAuthorizationRuntime = ReturnType<
  typeof createTelegramEventAuthorizationRuntime
>;
