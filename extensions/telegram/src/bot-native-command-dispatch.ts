import type { Bot, Context } from "grammy";
import type {
  ChannelGroupPolicy,
  OpenClawConfig,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramDmAllow } from "./access-groups.js";
import { resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { resolveTelegramEffectiveDmPolicy } from "./bot-access.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramResolvedGroupConfig } from "./bot-handlers.types.js";
import { resolveTelegramMessageTurnSettings } from "./bot-message.js";
import {
  defaultTelegramNativeCommandDeps,
  type TelegramNativeCommandDeps,
} from "./bot-native-command-deps.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import {
  buildTelegramThreadParams,
  extractTelegramForumFlag,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramForumFlag,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramMessageThreadSpec,
} from "./bot/helpers.js";
import {
  inspectTelegramConversationRoute,
  resolveTelegramTargetSession,
  touchTelegramConversationRoute,
} from "./conversation-route.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import {
  buildTelegramNativeCommandOwnerContext,
  resolveTelegramCommandIngressAuthorization,
} from "./ingress.js";
import { resolveTelegramRichMessages, resolveTelegramTableMode } from "./rich-messages-config.js";

const loadTelegramNativeCommandDeliveryRuntime = createLazyRuntimeModule(
  () => import("./bot/delivery.js"),
);
const loadTelegramNativeCommandRuntime = createLazyRuntimeModule(
  () => import("./bot-native-commands.runtime.js"),
);

type TelegramNativeCommandRuntime = Awaited<ReturnType<typeof loadTelegramNativeCommandRuntime>>;
type TelegramNativeCommandDeliveryRuntime = Awaited<
  ReturnType<typeof loadTelegramNativeCommandDeliveryRuntime>
>;
type DeliveryBaseOptions = Omit<
  Parameters<TelegramNativeCommandDeliveryRuntime["deliverReplies"]>[0],
  "replies" | "silent"
>;

export type TelegramCommandExecutorParams = {
  botUser: Context["me"];
  msg: NonNullable<Context["message"]>;
  rawText: string;
  bot: Bot;
  runtime: RuntimeEnv;
  accountId: string;
  mediaMaxBytes?: number;
  resolveGroupPolicy: (chatId: string | number, cfg: OpenClawConfig) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId: number | undefined,
    cfg: OpenClawConfig,
  ) => TelegramResolvedGroupConfig;
  telegramDeps?: TelegramNativeCommandDeps;
  opts: Pick<
    TelegramBotOptions,
    | "token"
    | "ownerAgentId"
    | "botInfo"
    | "allowFrom"
    | "groupAllowFrom"
    | "replyToMode"
    | "accountAbortSignal"
  >;
};

type TelegramCommandAuthResult = NonNullable<
  Awaited<ReturnType<typeof resolveTelegramCommandAuth>>
>;

export type TelegramCommandDispatch = TelegramCommandExecutorParams &
  TelegramCommandAuthResult & {
    telegramDeps: TelegramNativeCommandDeps;
    runtimeCfg: OpenClawConfig;
    runtimeTelegramCfg: TelegramAccountConfig;
    nativeCommandRuntime: TelegramNativeCommandRuntime;
    deliveryOptions: DeliveryBaseOptions;
    loadDeliveryRuntime: () => Promise<TelegramNativeCommandDeliveryRuntime>;
  };

export async function resolveTelegramNativeCommandThreadContext(params: {
  msg: NonNullable<Context["message"]>;
  bot: Bot;
}) {
  const { msg, bot } = params;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const isForum =
    msg.chat.is_direct_messages === true
      ? false
      : await resolveTelegramForumFlag({
          chatId,
          chatType: msg.chat.type,
          isGroup,
          isForum: extractTelegramForumFlag(msg.chat),
          isTopicMessage: msg.is_topic_message,
          getChat: (id) => bot.api.getChat(id),
        });
  const threadSpec = resolveTelegramMessageThreadSpec(msg, isForum);
  return {
    chatId,
    isGroup,
    isForum,
    threadSpec,
    threadParams: buildTelegramThreadParams(threadSpec),
  };
}

async function resolveTelegramCommandAuth(params: {
  botUser: Context["me"];
  msg: NonNullable<Context["message"]>;
  bot: Bot;
  cfg: OpenClawConfig;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  readChannelAllowFromStore: TelegramBotDeps["readChannelAllowFromStore"];
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  resolveGroupPolicy: TelegramCommandExecutorParams["resolveGroupPolicy"];
  resolveTelegramGroupConfig: TelegramCommandExecutorParams["resolveTelegramGroupConfig"];
  requireAuth: boolean;
}) {
  const { msg, bot, cfg, accountId, telegramCfg, requireAuth } = params;
  const { chatId, isGroup, isForum, threadSpec, threadParams } =
    await resolveTelegramNativeCommandThreadContext({ msg, bot });
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const senderUsername = msg.from?.username ?? "";
  const scopedConfig = params.resolveTelegramGroupConfig(chatId, threadSpec.id, cfg);
  const inspectedRoute = inspectTelegramConversationRoute({
    cfg,
    accountId,
    chatId,
    isGroup,
    threadSpec,
    senderId,
    topicAgentId: scopedConfig.topicConfig?.agentId,
  });
  const { route, bindingMode } = inspectedRoute;
  const targetSessionKey = resolveTelegramTargetSession({
    cfg,
    route,
    chatId,
    isGroup,
    senderId,
    dmThreadId: threadSpec.scope === "dm" ? threadSpec.id : undefined,
    botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(params.botUser),
  });
  const ingressParams = {
    cfg,
    accountId,
    chatId,
    isGroup,
    senderId,
    dmPolicy: telegramCfg.dmPolicy ?? "pairing",
  };
  const ownerContext = await buildTelegramNativeCommandOwnerContext({
    ...ingressParams,
    resolvedThreadId: threadSpec.id,
    agentId: route.agentId,
    sessionKey: targetSessionKey,
    messageId: String(msg.message_id),
    rawBody: msg.text ?? "",
  });
  const preContextCommandAccess = await resolveTelegramCommandIngressAuthorization({
    ...ingressParams,
    ownerContext,
  });
  const groupAllowContext = await resolveTelegramGroupAllowFromContext({
    cfg,
    chatId,
    accountId,
    dmPolicy: telegramCfg.dmPolicy,
    allowFrom: params.allowFrom,
    senderId,
    isGroup,
    threadSpec,
    groupAllowFrom: params.groupAllowFrom,
    skipPairingStoreRead: preContextCommandAccess.authorizedByConfig,
    readChannelAllowFromStore: params.readChannelAllowFromStore,
    resolveTelegramGroupConfig: () => scopedConfig,
  });
  const {
    resolvedThreadId,
    dmThreadId,
    storeAllowFrom,
    groupConfig,
    topicConfig,
    groupAllowOverride,
    effectiveGroupAllow,
  } = groupAllowContext;
  const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
    isGroup,
    groupConfig,
    dmPolicy: telegramCfg.dmPolicy,
  });
  const requireTopic =
    !isGroup && groupConfig && "requireTopic" in groupConfig ? groupConfig.requireTopic : undefined;
  if (!isGroup && requireTopic === true && dmThreadId == null) {
    logVerbose(`Blocked telegram command in DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }
  const rejectNotAuthorized = async () => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () =>
        bot.api.sendMessage(
          chatId,
          "You are not authorized to use this command.",
          threadParams ?? {},
        ),
    });
    return null;
  };

  const baseAccess = evaluateTelegramGroupBaseAccess({
    ...groupAllowContext,
    senderId,
    enforceAllowOverride: requireAuth,
    requireSenderForAllowOverride: true,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      logVerbose(`Blocked telegram command in group ${chatId} (group disabled)`);
      return null;
    }
    if (baseAccess.reason === "topic-disabled") {
      logVerbose(
        `Blocked telegram command in topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
      );
      return null;
    }
    return await rejectNotAuthorized();
  }

  const policyAccess = evaluateTelegramGroupPolicyAccess({
    ...groupAllowContext,
    isGroup,
    chatId,
    cfg,
    telegramCfg,
    senderId,
    resolveGroupPolicy: params.resolveGroupPolicy,
    enforceAllowlistAuthorization: requireAuth && !preContextCommandAccess.authorizedByConfig,
    allowEmptyAllowlistEntries: true,
  });
  if (!policyAccess.allowed) {
    if (policyAccess.reason === "group-policy-disabled") {
      logVerbose("Blocked telegram command (groupPolicy: disabled)");
      return null;
    }
    if (
      policyAccess.reason === "group-policy-allowlist-no-sender" ||
      policyAccess.reason === "group-policy-allowlist-unauthorized"
    ) {
      return await rejectNotAuthorized();
    }
    if (policyAccess.reason === "group-chat-not-allowed") {
      logVerbose(`Blocked telegram command in group ${chatId} (group not allowed)`);
      return null;
    }
  }

  const { effectiveAllow: dmAllow } = await resolveTelegramDmAllow({
    cfg,
    allowFrom: groupAllowOverride ?? params.allowFrom,
    accountId,
    senderId,
    storeAllowFrom: isGroup ? [] : storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  const {
    authorized: commandAuthorized,
    senderIsOwner,
    assertOwnerCurrent,
  } = await resolveTelegramCommandIngressAuthorization({
    ...ingressParams,
    dmPolicy: effectiveDmPolicy,
    resolvedThreadId,
    effectiveDmAllow: dmAllow,
    effectiveGroupAllow,
    eventKind: "native-command",
    ownerContext,
  });
  if (requireAuth && !commandAuthorized) {
    return await rejectNotAuthorized();
  }
  return {
    chatId,
    isGroup,
    isForum,
    resolvedThreadId,
    senderId,
    senderUsername,
    groupConfig,
    topicConfig,
    threadSpec,
    threadParams,
    commandAuthorized,
    senderIsOwner,
    assertOwnerCurrent,
    route,
    bindingMode,
    targetSessionKey,
    inspectedRoute,
    ownerContext,
  };
}

export async function prepareTelegramCommandDispatch(
  params: TelegramCommandExecutorParams & { requireAuth: boolean },
): Promise<TelegramCommandDispatch | null> {
  const telegramDeps = params.telegramDeps ?? defaultTelegramNativeCommandDeps;
  const runtimeCfg = telegramDeps.getRuntimeConfig();
  const runtimeTelegramCfg = resolveTelegramAccount({
    cfg: runtimeCfg,
    accountId: params.accountId,
  }).config;
  const turnSettings = resolveTelegramMessageTurnSettings({
    accountId: params.accountId,
    cfg: runtimeCfg,
    telegramCfg: runtimeTelegramCfg,
    opts: params.opts,
  });
  const auth = await resolveTelegramCommandAuth({
    ...params,
    cfg: runtimeCfg,
    telegramCfg: runtimeTelegramCfg,
    readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
    allowFrom: turnSettings.allowFrom,
    groupAllowFrom: turnSettings.groupAllowFrom,
  });
  if (!auth) {
    return null;
  }
  const { route, bindingMode } = auth;
  const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
  auth.assertOwnerCurrent?.();
  await touchTelegramConversationRoute(auth.inspectedRoute);
  auth.assertOwnerCurrent?.();
  if (bindingMode.kind === "configured") {
    auth.assertOwnerCurrent?.();
    const ensured = await nativeCommandRuntime.ensureConfiguredBindingRouteReady({
      cfg: runtimeCfg,
      bindingResolution: bindingMode.binding,
      assertActive: auth.assertOwnerCurrent,
    });
    if (!ensured.ok) {
      logVerbose(
        `telegram native command: configured ACP binding unavailable for topic ${bindingMode.binding.record.conversation.conversationId}: ${ensured.error}`,
      );
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime: params.runtime,
        fn: () =>
          params.bot.api.sendMessage(
            auth.chatId,
            "Configured ACP binding is unavailable right now. Please try again.",
            buildTelegramThreadParams(auth.threadSpec) ?? {},
          ),
      });
      return null;
    }
  }
  const mediaLocalRoots = nativeCommandRuntime.getAgentScopedMediaLocalRoots(
    runtimeCfg,
    route.agentId,
  );
  const richMessagesParams = {
    cfg: runtimeCfg,
    accountId: route.accountId,
    accountConfig: runtimeTelegramCfg,
  };
  const richMessages = resolveTelegramRichMessages(richMessagesParams);
  const tableMode = resolveTelegramTableMode(richMessagesParams);
  const chunkMode = nativeCommandRuntime.resolveChunkMode(runtimeCfg, "telegram", route.accountId);
  const deliveryOptions: DeliveryBaseOptions = {
    cfg: runtimeCfg,
    ownerAgentId: params.opts.ownerAgentId,
    chatId: String(auth.chatId),
    accountId: route.accountId,
    sessionKeyForInternalHooks: auth.targetSessionKey,
    policySessionKey: auth.targetSessionKey,
    mirrorIsGroup: auth.isGroup,
    mirrorGroupId: auth.isGroup ? String(auth.chatId) : undefined,
    token: params.opts.token,
    runtime: params.runtime,
    bot: params.bot,
    mediaLocalRoots,
    mediaMaxBytes: params.mediaMaxBytes,
    replyToMode: turnSettings.replyToMode,
    textLimit: turnSettings.textLimit,
    thread: auth.threadSpec,
    tableMode,
    chunkMode,
    linkPreview: runtimeTelegramCfg.linkPreview,
    richMessages,
  };
  return {
    ...params,
    telegramDeps,
    runtimeCfg,
    runtimeTelegramCfg,
    ...auth,
    nativeCommandRuntime,
    deliveryOptions,
    loadDeliveryRuntime: loadTelegramNativeCommandDeliveryRuntime,
  };
}
