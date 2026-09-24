import type { Bot, Context } from "grammy";
import type {
  ChannelGroupPolicy,
  OpenClawConfig,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { logVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { normalizeDmAllowFromWithStore, resolveTelegramEffectiveDmPolicy } from "./bot-access.js";
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
import type { TelegramGetChat } from "./bot/types.js";
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

const loadTelegramNativeCommandDeliveryRuntime = createLazyRuntimeModule(
  () => import("./bot-native-commands.delivery.runtime.js"),
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
    turnSettings: ReturnType<typeof resolveTelegramMessageTurnSettings>;
    threadParams: ReturnType<typeof buildTelegramThreadParams>;
    route: ReturnType<typeof inspectTelegramConversationRoute>["route"];
    mediaLocalRoots: readonly string[] | undefined;
    targetSessionKey: string;
    nativeCommandRuntime: TelegramNativeCommandRuntime;
    buildDeliveryBaseOptions: (params?: {
      sessionKeyForInternalHooks?: string;
      policySessionKey?: string;
    }) => DeliveryBaseOptions;
    loadDeliveryRuntime: () => Promise<TelegramNativeCommandDeliveryRuntime>;
  };

export async function resolveTelegramNativeCommandThreadContext(params: {
  msg: NonNullable<Context["message"]>;
  bot: Bot;
}) {
  const { msg, bot } = params;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const getChat =
    typeof bot.api.getChat === "function"
      ? (bot.api.getChat.bind(bot.api) as TelegramGetChat)
      : undefined;
  const isForum =
    msg.chat.is_direct_messages === true
      ? false
      : await resolveTelegramForumFlag({
          chatId,
          chatType: msg.chat.type,
          isGroup,
          isForum: extractTelegramForumFlag(msg.chat),
          isTopicMessage: msg.is_topic_message,
          getChat,
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
  const ownerContext = await buildTelegramNativeCommandOwnerContext({
    cfg,
    accountId,
    chatId,
    isGroup,
    resolvedThreadId: threadSpec.id,
    senderId,
    dmPolicy: telegramCfg.dmPolicy ?? "pairing",
    agentId: route.agentId,
    sessionKey: targetSessionKey,
    messageId: String(msg.message_id),
    rawBody: msg.text ?? "",
  });
  const preContextCommandAccess = await resolveTelegramCommandIngressAuthorization({
    cfg,
    accountId,
    chatId,
    isGroup,
    senderId,
    dmPolicy: telegramCfg.dmPolicy ?? "pairing",
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
    hasGroupAllowOverride,
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
  const sendAuthMessage = async (text: string) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, text, threadParams ?? {}),
    });
    return null;
  };
  const rejectNotAuthorized = async () =>
    await sendAuthMessage("You are not authorized to use this command.");

  const baseAccess = evaluateTelegramGroupBaseAccess({
    isGroup,
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    senderUsername,
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
    isGroup,
    chatId,
    cfg,
    telegramCfg,
    topicConfig,
    groupConfig,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    resolveGroupPolicy: params.resolveGroupPolicy,
    enforcePolicy: true,
    enforceAllowlistAuthorization: requireAuth && !preContextCommandAccess.authorizedByConfig,
    allowEmptyAllowlistEntries: true,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: true,
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

  const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg,
    allowFrom: groupAllowOverride ?? params.allowFrom,
    accountId,
    senderId,
  });
  const dmAllow = normalizeDmAllowFromWithStore({
    allowFrom: expandedDmAllowFrom,
    storeAllowFrom: isGroup ? [] : storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  const {
    authorized: commandAuthorized,
    senderIsOwner,
    assertOwnerCurrent,
  } = await resolveTelegramCommandIngressAuthorization({
    accountId,
    cfg,
    dmPolicy: effectiveDmPolicy,
    isGroup,
    chatId,
    resolvedThreadId,
    senderId,
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
    botUser: params.botUser,
    msg: params.msg,
    bot: params.bot,
    cfg: runtimeCfg,
    accountId: params.accountId,
    telegramCfg: runtimeTelegramCfg,
    readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
    allowFrom: turnSettings.allowFrom,
    groupAllowFrom: turnSettings.groupAllowFrom,
    resolveGroupPolicy: params.resolveGroupPolicy,
    resolveTelegramGroupConfig: params.resolveTelegramGroupConfig,
    requireAuth: params.requireAuth,
  });
  if (!auth) {
    return null;
  }
  const { route, bindingMode, targetSessionKey } = auth;
  const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
  auth.assertOwnerCurrent?.();
  touchTelegramConversationRoute(auth.inspectedRoute);
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
  const tableMode = resolveMarkdownTableMode({
    cfg: runtimeCfg,
    channel: "telegram",
    accountId: route.accountId,
    supportsBlockTables: true,
  });
  const chunkMode = nativeCommandRuntime.resolveChunkMode(runtimeCfg, "telegram", route.accountId);
  const buildDeliveryBaseOptions: TelegramCommandDispatch["buildDeliveryBaseOptions"] = (keys) => ({
    cfg: runtimeCfg,
    ownerAgentId: params.opts.ownerAgentId,
    chatId: String(auth.chatId),
    accountId: route.accountId,
    sessionKeyForInternalHooks: keys?.sessionKeyForInternalHooks,
    policySessionKey: keys?.policySessionKey,
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
    richMessages: runtimeTelegramCfg.richMessages,
  });
  return {
    ...params,
    telegramDeps,
    runtimeCfg,
    runtimeTelegramCfg,
    turnSettings,
    ...auth,
    threadParams: buildTelegramThreadParams(auth.threadSpec),
    route,
    mediaLocalRoots,
    targetSessionKey,
    nativeCommandRuntime,
    buildDeliveryBaseOptions,
    loadDeliveryRuntime: loadTelegramNativeCommandDeliveryRuntime,
  };
}
