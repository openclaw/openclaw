import {
  buildAgentMediaPayload,
  buildModelsProviderData,
  DM_GROUP_ACCESS_REASON,
  createScopedPairingAccess,
  createReplyPrefixOptions,
  createTypingCallbacks,
  logInboundDrop,
  logTypingFailure,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  isDangerousNameMatchingEnabled,
  parseStrictPositiveInteger,
  registerPluginHttpRoute,
  resolveControlCommandGate,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveChannelMediaMaxBytes,
  warnMissingProviderGroupPolicyFallbackOnce,
  listSkillCommandsForAgents
} from "openclaw/plugin-sdk/mattermost";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount, resolveMattermostReplyToMode } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostMe,
  fetchMattermostUser,
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  sendMattermostTyping,
  updateMattermostPost
} from "./client.js";
import {
  buildButtonProps,
  computeInteractionCallbackUrl,
  createMattermostInteractionHandler,
  resolveInteractionCallbackPath,
  setInteractionCallbackUrl,
  setInteractionSecret
} from "./interactions.js";
import {
  buildMattermostAllowedModelRefs,
  parseMattermostModelPickerContext,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel
} from "./model-picker.js";
import {
  authorizeMattermostCommandInvocation,
  isMattermostSenderAllowed,
  normalizeMattermostAllowList
} from "./monitor-auth.js";
import {
  createDedupeCache,
  formatInboundFromLabel,
  normalizeMention,
  resolveThreadSessionKeys
} from "./monitor-helpers.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import {
  createMattermostConnectOnce
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import { sendMessageMattermost } from "./send.js";
import {
  DEFAULT_COMMAND_SPECS,
  cleanupSlashCommands,
  isSlashCommandsEnabled,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveSlashCommandConfig
} from "./slash-commands.js";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  getSlashCommandState
} from "./slash-state.js";
const RECENT_MATTERMOST_MESSAGE_TTL_MS = 5 * 6e4;
const RECENT_MATTERMOST_MESSAGE_MAX = 2e3;
const CHANNEL_CACHE_TTL_MS = 5 * 6e4;
const USER_CACHE_TTL_MS = 10 * 6e4;
function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
function normalizeInteractionSourceIps(values) {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_MATTERMOST_MESSAGE_TTL_MS,
  maxSize: RECENT_MATTERMOST_MESSAGE_MAX
});
function resolveRuntime(opts) {
  return opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code) => {
      throw new Error(`exit ${code}`);
    }
  };
}
function isSystemPost(post) {
  const type = post.type?.trim();
  return Boolean(type);
}
function mapMattermostChannelTypeToChatType(channelType) {
  if (!channelType) {
    return "channel";
  }
  const normalized = channelType.trim().toUpperCase();
  if (normalized === "D") {
    return "direct";
  }
  if (normalized === "G") {
    return "group";
  }
  if (normalized === "P") {
    return "group";
  }
  return "channel";
}
function channelChatType(kind) {
  if (kind === "direct") {
    return "direct";
  }
  if (kind === "group") {
    return "group";
  }
  return "channel";
}
function evaluateMattermostMentionGate(params) {
  const shouldRequireMention = params.kind !== "direct" && params.resolveRequireMention({
    cfg: params.cfg,
    channel: "mattermost",
    accountId: params.accountId,
    groupId: params.channelId,
    requireMentionOverride: params.requireMentionOverride
  });
  const shouldBypassMention = params.isControlCommand && shouldRequireMention && !params.wasMentioned && params.commandAuthorized;
  const effectiveWasMentioned = params.wasMentioned || shouldBypassMention || params.oncharTriggered;
  if (params.oncharEnabled && !params.oncharTriggered && !params.wasMentioned && !params.isControlCommand) {
    return {
      shouldRequireMention,
      shouldBypassMention,
      effectiveWasMentioned,
      dropReason: "onchar-not-triggered"
    };
  }
  if (params.kind !== "direct" && shouldRequireMention && params.canDetectMention && !effectiveWasMentioned) {
    return {
      shouldRequireMention,
      shouldBypassMention,
      effectiveWasMentioned,
      dropReason: "missing-mention"
    };
  }
  return {
    shouldRequireMention,
    shouldBypassMention,
    effectiveWasMentioned,
    dropReason: null
  };
}
function resolveMattermostReplyRootId(params) {
  const threadRootId = params.threadRootId?.trim();
  if (threadRootId) {
    return threadRootId;
  }
  return params.replyToId?.trim() || void 0;
}
function resolveMattermostEffectiveReplyToId(params) {
  const threadRootId = params.threadRootId?.trim();
  if (threadRootId) {
    return threadRootId;
  }
  if (params.kind === "direct") {
    return void 0;
  }
  const postId = params.postId?.trim();
  if (!postId) {
    return void 0;
  }
  return params.replyToMode === "all" || params.replyToMode === "first" ? postId : void 0;
}
function resolveMattermostThreadSessionContext(params) {
  const effectiveReplyToId = resolveMattermostEffectiveReplyToId({
    kind: params.kind,
    postId: params.postId,
    replyToMode: params.replyToMode,
    threadRootId: params.threadRootId
  });
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    threadId: effectiveReplyToId,
    parentSessionKey: effectiveReplyToId ? params.baseSessionKey : void 0
  });
  return {
    effectiveReplyToId,
    sessionKey: threadKeys.sessionKey,
    parentSessionKey: threadKeys.parentSessionKey
  };
}
function buildMattermostAttachmentPlaceholder(mediaList) {
  if (mediaList.length === 0) {
    return "";
  }
  if (mediaList.length === 1) {
    const kind = mediaList[0].kind === "unknown" ? "document" : mediaList[0].kind;
    return `<media:${kind}>`;
  }
  const allImages = mediaList.every((media) => media.kind === "image");
  const label = allImages ? "image" : "file";
  const suffix = mediaList.length === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${mediaList.length} ${suffix})`;
}
function buildMattermostWsUrl(baseUrl) {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  const wsBase = normalized.replace(/^http/i, "ws");
  return `${wsBase}/api/v4/websocket`;
}
async function monitorMattermostProvider(opts = {}) {
  const core = getMattermostRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveMattermostAccount({
    cfg,
    accountId: opts.accountId
  });
  const pairing = createScopedPairingAccess({
    core,
    channel: "mattermost",
    accountId: account.accountId
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const botToken = opts.botToken?.trim() || account.botToken?.trim();
  if (!botToken) {
    throw new Error(
      `Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`
    );
  }
  const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`
    );
  }
  const client = createMattermostClient({ baseUrl, botToken });
  const botUser = await fetchMattermostMe(client);
  const botUserId = botUser.id;
  const botUsername = botUser.username?.trim() || void 0;
  runtime.log?.(`mattermost connected as ${botUsername ? `@${botUsername}` : botUserId}`);
  const commandsRaw = account.config.commands;
  const slashConfig = resolveSlashCommandConfig(commandsRaw);
  const slashEnabled = isSlashCommandsEnabled(slashConfig);
  if (slashEnabled) {
    try {
      const teams = await fetchMattermostUserTeams(client, botUserId);
      const envPortRaw = process.env.OPENCLAW_GATEWAY_PORT?.trim();
      const envPort = parseStrictPositiveInteger(envPortRaw);
      const slashGatewayPort = envPort ?? cfg.gateway?.port ?? 18789;
      const slashCallbackUrl = resolveCallbackUrl({
        config: slashConfig,
        gatewayPort: slashGatewayPort,
        gatewayHost: cfg.gateway?.customBindHost ?? void 0
      });
      try {
        const mmHost = new URL(baseUrl).hostname;
        const callbackHost = new URL(slashCallbackUrl).hostname;
        if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) {
          runtime.error?.(
            `mattermost: slash commands callbackUrl resolved to ${slashCallbackUrl} (loopback) while baseUrl is ${baseUrl}. This MAY be unreachable depending on your deployment. If native slash commands don't work, set channels.mattermost.commands.callbackUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`
          );
        }
      } catch {
      }
      const commandsToRegister = [
        ...DEFAULT_COMMAND_SPECS
      ];
      if (slashConfig.nativeSkills === true) {
        try {
          const skillCommands = listSkillCommandsForAgents({ cfg });
          for (const spec of skillCommands) {
            const name = typeof spec.name === "string" ? spec.name.trim() : "";
            if (!name) continue;
            const trigger = name.startsWith("oc_") ? name : `oc_${name}`;
            commandsToRegister.push({
              trigger,
              description: spec.description || `Run skill ${name}`,
              autoComplete: true,
              autoCompleteHint: "[args]",
              originalName: name
            });
          }
        } catch (err) {
          runtime.error?.(`mattermost: failed to list skill commands: ${String(err)}`);
        }
      }
      const seen = /* @__PURE__ */ new Set();
      const dedupedCommands = commandsToRegister.filter((cmd) => {
        const key = cmd.trigger.trim();
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const allRegistered = [];
      let teamRegistrationFailures = 0;
      for (const team of teams) {
        try {
          const registered = await registerSlashCommands({
            client,
            teamId: team.id,
            creatorUserId: botUserId,
            callbackUrl: slashCallbackUrl,
            commands: dedupedCommands,
            log: (msg) => runtime.log?.(msg)
          });
          allRegistered.push(...registered);
        } catch (err) {
          teamRegistrationFailures += 1;
          runtime.error?.(
            `mattermost: failed to register slash commands for team ${team.id}: ${String(err)}`
          );
        }
      }
      if (allRegistered.length === 0) {
        runtime.error?.(
          "mattermost: native slash commands enabled but no commands could be registered; keeping slash callbacks inactive"
        );
      } else {
        if (teamRegistrationFailures > 0) {
          runtime.error?.(
            `mattermost: slash command registration completed with ${teamRegistrationFailures} team error(s)`
          );
        }
        const triggerMap = /* @__PURE__ */ new Map();
        for (const cmd of dedupedCommands) {
          if (cmd.originalName) {
            triggerMap.set(cmd.trigger, cmd.originalName);
          }
        }
        activateSlashCommands({
          account,
          commandTokens: allRegistered.map((cmd) => cmd.token).filter(Boolean),
          registeredCommands: allRegistered,
          triggerMap,
          api: { cfg, runtime },
          log: (msg) => runtime.log?.(msg)
        });
        runtime.log?.(
          `mattermost: slash commands registered (${allRegistered.length} commands across ${teams.length} teams, callback=${slashCallbackUrl})`
        );
      }
    } catch (err) {
      runtime.error?.(`mattermost: failed to register slash commands: ${String(err)}`);
    }
  }
  setInteractionSecret(account.accountId, botToken);
  const interactionPath = resolveInteractionCallbackPath(account.accountId);
  const callbackUrl = computeInteractionCallbackUrl(account.accountId, {
    gateway: cfg.gateway,
    interactions: account.config.interactions
  });
  setInteractionCallbackUrl(account.accountId, callbackUrl);
  const allowedInteractionSourceIps = normalizeInteractionSourceIps(
    account.config.interactions?.allowedSourceIps
  );
  try {
    const mmHost = new URL(baseUrl).hostname;
    const callbackHost = new URL(callbackUrl).hostname;
    if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) {
      runtime.error?.(
        `mattermost: interactions callbackUrl resolved to ${callbackUrl} (loopback) while baseUrl is ${baseUrl}. This MAY be unreachable depending on your deployment. If button clicks don't work, set channels.mattermost.interactions.callbackBaseUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`
      );
    }
    if (!isLoopbackHost(callbackHost) && allowedInteractionSourceIps.length === 0) {
      runtime.error?.(
        `mattermost: interactions callbackUrl resolved to ${callbackUrl} without channels.mattermost.interactions.allowedSourceIps. For safety, non-loopback callback sources will be rejected until you allowlist the Mattermost server or trusted ingress IPs.`
      );
    }
  } catch {
  }
  const effectiveInteractionSourceIps = allowedInteractionSourceIps.length > 0 ? allowedInteractionSourceIps : ["127.0.0.1", "::1"];
  const unregisterInteractions = registerPluginHttpRoute({
    path: interactionPath,
    fallbackPath: "/mattermost/interactions/default",
    auth: "plugin",
    handler: createMattermostInteractionHandler({
      client,
      botUserId,
      accountId: account.accountId,
      allowedSourceIps: effectiveInteractionSourceIps,
      trustedProxies: cfg.gateway?.trustedProxies,
      allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
      handleInteraction: handleModelPickerInteraction,
      resolveSessionKey: async ({ channelId, userId, post }) => {
        const channelInfo = await resolveChannelInfo(channelId);
        const kind = mapMattermostChannelTypeToChatType(channelInfo?.type);
        const teamId = channelInfo?.team_id ?? void 0;
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId,
          peer: {
            kind,
            id: kind === "direct" ? userId : channelId
          }
        });
        const replyToMode = resolveMattermostReplyToMode(account, kind);
        return resolveMattermostThreadSessionContext({
          baseSessionKey: route.sessionKey,
          kind,
          postId: post.id || void 0,
          replyToMode,
          threadRootId: post.root_id
        }).sessionKey;
      },
      dispatchButtonClick: async (opts2) => {
        const channelInfo = await resolveChannelInfo(opts2.channelId);
        const kind = mapMattermostChannelTypeToChatType(channelInfo?.type);
        const chatType = channelChatType(kind);
        const teamId = channelInfo?.team_id ?? void 0;
        const channelName = channelInfo?.name ?? void 0;
        const channelDisplay = channelInfo?.display_name ?? channelName ?? opts2.channelId;
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId,
          peer: {
            kind,
            id: kind === "direct" ? opts2.userId : opts2.channelId
          }
        });
        const replyToMode = resolveMattermostReplyToMode(account, kind);
        const threadContext = resolveMattermostThreadSessionContext({
          baseSessionKey: route.sessionKey,
          kind,
          postId: opts2.post.id || opts2.postId,
          replyToMode,
          threadRootId: opts2.post.root_id
        });
        const to = kind === "direct" ? `user:${opts2.userId}` : `channel:${opts2.channelId}`;
        const bodyText = `[Button click: user @${opts2.userName} selected "${opts2.actionName}"]`;
        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: bodyText,
          BodyForAgent: bodyText,
          RawBody: bodyText,
          CommandBody: bodyText,
          From: kind === "direct" ? `mattermost:${opts2.userId}` : kind === "group" ? `mattermost:group:${opts2.channelId}` : `mattermost:channel:${opts2.channelId}`,
          To: to,
          SessionKey: threadContext.sessionKey,
          ParentSessionKey: threadContext.parentSessionKey,
          AccountId: route.accountId,
          ChatType: chatType,
          ConversationLabel: `mattermost:${opts2.userName}`,
          GroupSubject: kind !== "direct" ? channelDisplay : void 0,
          GroupChannel: channelName ? `#${channelName}` : void 0,
          GroupSpace: teamId,
          SenderName: opts2.userName,
          SenderId: opts2.userId,
          Provider: "mattermost",
          Surface: "mattermost",
          MessageSid: `interaction:${opts2.postId}:${opts2.actionId}`,
          ReplyToId: threadContext.effectiveReplyToId,
          MessageThreadId: threadContext.effectiveReplyToId,
          WasMentioned: true,
          CommandAuthorized: false,
          OriginatingChannel: "mattermost",
          OriginatingTo: to
        });
        const textLimit = core.channel.text.resolveTextChunkLimit(
          cfg,
          "mattermost",
          account.accountId,
          { fallbackLimit: account.textChunkLimit ?? 4e3 }
        );
        const tableMode = core.channel.text.resolveMarkdownTableMode({
          cfg,
          channel: "mattermost",
          accountId: account.accountId
        });
        const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
          cfg,
          agentId: route.agentId,
          channel: "mattermost",
          accountId: account.accountId
        });
        const typingCallbacks = createTypingCallbacks({
          start: () => sendTypingIndicator(opts2.channelId, threadContext.effectiveReplyToId),
          onStartError: (err) => {
            logTypingFailure({
              log: (message) => logger.debug?.(message),
              channel: "mattermost",
              target: opts2.channelId,
              error: err
            });
          }
        });
        const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
          ...prefixOptions,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            await deliverMattermostReplyPayload({
              core,
              cfg,
              payload,
              to,
              accountId: account.accountId,
              agentId: route.agentId,
              replyToId: resolveMattermostReplyRootId({
                threadRootId: threadContext.effectiveReplyToId,
                replyToId: payload.replyToId
              }),
              textLimit,
              tableMode,
              sendMessage: sendMessageMattermost
            });
            runtime.log?.(`delivered button-click reply to ${to}`);
          },
          onError: (err, info) => {
            runtime.error?.(`mattermost button-click ${info.kind} reply failed: ${String(err)}`);
          },
          onReplyStart: typingCallbacks.onReplyStart
        });
        await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming: typeof account.blockStreaming === "boolean" ? !account.blockStreaming : void 0,
            onModelSelected
          }
        });
        markDispatchIdle();
      },
      log: (msg) => runtime.log?.(msg)
    }),
    pluginId: "mattermost",
    source: "mattermost-interactions",
    accountId: account.accountId,
    log: (msg) => runtime.log?.(msg)
  });
  const channelCache = /* @__PURE__ */ new Map();
  const userCache = /* @__PURE__ */ new Map();
  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const logVerboseMessage = (message) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };
  const mediaMaxBytes = resolveChannelMediaMaxBytes({
    cfg,
    resolveChannelLimitMb: () => void 0,
    accountId: account.accountId
  }) ?? 8 * 1024 * 1024;
  const historyLimit = Math.max(
    0,
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT
  );
  const channelHistories = /* @__PURE__ */ new Map();
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.mattermost !== void 0,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "mattermost",
    accountId: account.accountId,
    log: (message) => logVerboseMessage(message)
  });
  const resolveMattermostMedia = async (fileIds) => {
    const ids = (fileIds ?? []).map((id) => id?.trim()).filter(Boolean);
    if (ids.length === 0) {
      return [];
    }
    const out = [];
    for (const fileId of ids) {
      try {
        const fetched = await core.channel.media.fetchRemoteMedia({
          url: `${client.apiBaseUrl}/files/${fileId}`,
          requestInit: {
            headers: {
              Authorization: `Bearer ${client.token}`
            }
          },
          filePathHint: fileId,
          maxBytes: mediaMaxBytes,
          // Allow fetching from the Mattermost server host (may be localhost or
          // a private IP). Without this, SSRF guards block media downloads.
          // Credit: #22594 (@webclerk)
          ssrfPolicy: { allowedHostnames: [new URL(client.baseUrl).hostname] }
        });
        const saved = await core.channel.media.saveMediaBuffer(
          fetched.buffer,
          fetched.contentType ?? void 0,
          "inbound",
          mediaMaxBytes
        );
        const contentType = saved.contentType ?? fetched.contentType ?? void 0;
        out.push({
          path: saved.path,
          contentType,
          kind: core.media.mediaKindFromMime(contentType) ?? "unknown"
        });
      } catch (err) {
        logger.debug?.(`mattermost: failed to download file ${fileId}: ${String(err)}`);
      }
    }
    return out;
  };
  const sendTypingIndicator = async (channelId, parentId) => {
    await sendMattermostTyping(client, { channelId, parentId });
  };
  const resolveChannelInfo = async (channelId) => {
    const cached = channelCache.get(channelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchMattermostChannel(client, channelId);
      channelCache.set(channelId, {
        value: info,
        expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS
      });
      return info;
    } catch (err) {
      logger.debug?.(`mattermost: channel lookup failed: ${String(err)}`);
      channelCache.set(channelId, {
        value: null,
        expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS
      });
      return null;
    }
  };
  const resolveUserInfo = async (userId) => {
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchMattermostUser(client, userId);
      userCache.set(userId, {
        value: info,
        expiresAt: Date.now() + USER_CACHE_TTL_MS
      });
      return info;
    } catch (err) {
      logger.debug?.(`mattermost: user lookup failed: ${String(err)}`);
      userCache.set(userId, {
        value: null,
        expiresAt: Date.now() + USER_CACHE_TTL_MS
      });
      return null;
    }
  };
  const buildModelPickerProps = (channelId, buttons) => buildButtonProps({
    callbackUrl,
    accountId: account.accountId,
    channelId,
    buttons
  });
  const updateModelPickerPost = async (params) => {
    const props = buildModelPickerProps(params.channelId, params.buttons ?? []) ?? {
      attachments: []
    };
    await updateMattermostPost(client, params.postId, {
      message: params.message,
      props
    });
    return {};
  };
  const runModelPickerCommand = async (params) => {
    const to = params.kind === "direct" ? `user:${params.senderId}` : `channel:${params.channelId}`;
    const fromLabel = params.kind === "direct" ? `Mattermost DM from ${params.senderName}` : `Mattermost message in ${params.roomLabel} from ${params.senderName}`;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: params.commandText,
      BodyForAgent: params.commandText,
      RawBody: params.commandText,
      CommandBody: params.commandText,
      From: params.kind === "direct" ? `mattermost:${params.senderId}` : params.kind === "group" ? `mattermost:group:${params.channelId}` : `mattermost:channel:${params.channelId}`,
      To: to,
      SessionKey: params.sessionKey,
      ParentSessionKey: params.parentSessionKey,
      AccountId: params.route.accountId,
      ChatType: params.chatType,
      ConversationLabel: fromLabel,
      GroupSubject: params.kind !== "direct" ? params.channelDisplay || params.roomLabel : void 0,
      GroupChannel: params.channelName ? `#${params.channelName}` : void 0,
      GroupSpace: params.teamId,
      SenderName: params.senderName,
      SenderId: params.senderId,
      Provider: "mattermost",
      Surface: "mattermost",
      MessageSid: `interaction:${params.postId}:${Date.now()}`,
      ReplyToId: params.effectiveReplyToId,
      MessageThreadId: params.effectiveReplyToId,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: params.commandAuthorized,
      CommandSource: "native",
      OriginatingChannel: "mattermost",
      OriginatingTo: to
    });
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "mattermost",
      accountId: account.accountId
    });
    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "mattermost",
      account.accountId,
      {
        fallbackLimit: account.textChunkLimit ?? 4e3
      }
    );
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: params.route.agentId,
      channel: "mattermost",
      accountId: account.accountId
    });
    const shouldDeliverReplies = params.deliverReplies === true;
    const capturedTexts = [];
    const typingCallbacks = shouldDeliverReplies ? createTypingCallbacks({
      start: () => sendTypingIndicator(params.channelId, params.effectiveReplyToId),
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => logger.debug?.(message),
          channel: "mattermost",
          target: params.channelId,
          error: err
        });
      }
    }) : void 0;
    const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      // Picker-triggered confirmations should stay immediate.
      deliver: async (payload) => {
        const trimmedPayload = {
          ...payload,
          text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode).trim()
        };
        if (!shouldDeliverReplies) {
          if (trimmedPayload.text) {
            capturedTexts.push(trimmedPayload.text);
          }
          return;
        }
        await deliverMattermostReplyPayload({
          core,
          cfg,
          payload: trimmedPayload,
          to,
          accountId: account.accountId,
          agentId: params.route.agentId,
          replyToId: resolveMattermostReplyRootId({
            threadRootId: params.effectiveReplyToId,
            replyToId: trimmedPayload.replyToId
          }),
          textLimit,
          // The picker path already converts and trims text before capture/delivery.
          tableMode: "off",
          sendMessage: sendMessageMattermost
        });
      },
      onError: (err, info) => {
        runtime.error?.(`mattermost model picker ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: typingCallbacks?.onReplyStart
    });
    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markDispatchIdle();
      },
      run: () => core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming: typeof account.blockStreaming === "boolean" ? !account.blockStreaming : void 0,
          onModelSelected
        }
      })
    });
    return capturedTexts.join("\n\n").trim();
  };
  async function handleModelPickerInteraction(params) {
    const pickerState = parseMattermostModelPickerContext(params.context);
    if (!pickerState) {
      return null;
    }
    if (pickerState.ownerUserId !== params.payload.user_id) {
      return {
        ephemeral_text: "Only the person who opened this picker can use it."
      };
    }
    const channelInfo = await resolveChannelInfo(params.payload.channel_id);
    const pickerCommandText = pickerState.action === "select" ? `/model ${pickerState.provider}/${pickerState.model}` : pickerState.action === "list" ? `/models ${pickerState.provider}` : "/models";
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost"
    });
    const hasControlCommand = core.channel.text.hasControlCommand(pickerCommandText, cfg);
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        provider: "mattermost",
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy
      })
    );
    const auth = authorizeMattermostCommandInvocation({
      account,
      cfg,
      senderId: params.payload.user_id,
      senderName: params.userName,
      channelId: params.payload.channel_id,
      channelInfo,
      storeAllowFrom,
      allowTextCommands,
      hasControlCommand
    });
    if (!auth.ok) {
      if (auth.denyReason === "dm-pairing") {
        const { code } = await pairing.upsertPairingRequest({
          id: params.payload.user_id,
          meta: { name: params.userName }
        });
        return {
          ephemeral_text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            idLine: `Your Mattermost user id: ${params.payload.user_id}`,
            code
          })
        };
      }
      const denyText = auth.denyReason === "unknown-channel" ? "Temporary error: unable to determine channel type. Please try again." : auth.denyReason === "dm-disabled" ? "This bot is not accepting direct messages." : auth.denyReason === "channels-disabled" ? "Model picker actions are disabled in channels." : auth.denyReason === "channel-no-allowlist" ? "Model picker actions are not configured for this channel." : "Unauthorized.";
      return {
        ephemeral_text: denyText
      };
    }
    const kind = auth.kind;
    const chatType = auth.chatType;
    const teamId = auth.channelInfo.team_id ?? params.payload.team_id ?? void 0;
    const channelName = auth.channelName || void 0;
    const channelDisplay = auth.channelDisplay || auth.channelName || params.payload.channel_id;
    const roomLabel = auth.roomLabel;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? params.payload.user_id : params.payload.channel_id
      }
    });
    const replyToMode = resolveMattermostReplyToMode(account, kind);
    const threadContext = resolveMattermostThreadSessionContext({
      baseSessionKey: route.sessionKey,
      kind,
      postId: params.post.id || params.payload.post_id,
      replyToMode,
      threadRootId: params.post.root_id
    });
    const modelSessionRoute = {
      agentId: route.agentId,
      sessionKey: threadContext.sessionKey
    };
    const data = await buildModelsProviderData(cfg, route.agentId);
    if (data.providers.length === 0) {
      return await updateModelPickerPost({
        channelId: params.payload.channel_id,
        postId: params.payload.post_id,
        message: "No models available."
      });
    }
    if (pickerState.action === "providers" || pickerState.action === "back") {
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data
      });
      const view = renderMattermostProviderPickerView({
        ownerUserId: pickerState.ownerUserId,
        data,
        currentModel
      });
      return await updateModelPickerPost({
        channelId: params.payload.channel_id,
        postId: params.payload.post_id,
        message: view.text,
        buttons: view.buttons
      });
    }
    if (pickerState.action === "list") {
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data
      });
      const view = renderMattermostModelsPickerView({
        ownerUserId: pickerState.ownerUserId,
        data,
        provider: pickerState.provider,
        page: pickerState.page,
        currentModel
      });
      return await updateModelPickerPost({
        channelId: params.payload.channel_id,
        postId: params.payload.post_id,
        message: view.text,
        buttons: view.buttons
      });
    }
    const targetModelRef = `${pickerState.provider}/${pickerState.model}`;
    if (!buildMattermostAllowedModelRefs(data).has(targetModelRef)) {
      return {
        ephemeral_text: `That model is no longer available: ${targetModelRef}`
      };
    }
    void (async () => {
      try {
        await runModelPickerCommand({
          commandText: `/model ${targetModelRef}`,
          commandAuthorized: auth.commandAuthorized,
          route,
          sessionKey: threadContext.sessionKey,
          parentSessionKey: threadContext.parentSessionKey,
          channelId: params.payload.channel_id,
          senderId: params.payload.user_id,
          senderName: params.userName,
          kind,
          chatType,
          channelName,
          channelDisplay,
          roomLabel,
          teamId,
          postId: params.payload.post_id,
          effectiveReplyToId: threadContext.effectiveReplyToId,
          deliverReplies: true
        });
        const updatedModel = resolveMattermostModelPickerCurrentModel({
          cfg,
          route: modelSessionRoute,
          data,
          skipCache: true
        });
        const view = renderMattermostModelsPickerView({
          ownerUserId: pickerState.ownerUserId,
          data,
          provider: pickerState.provider,
          page: pickerState.page,
          currentModel: updatedModel
        });
        await updateModelPickerPost({
          channelId: params.payload.channel_id,
          postId: params.payload.post_id,
          message: view.text,
          buttons: view.buttons
        });
      } catch (err) {
        runtime.error?.(`mattermost model picker select failed: ${String(err)}`);
      }
    })();
    return {};
  }
  const handlePost = async (post, payload, messageIds) => {
    const channelId = post.channel_id ?? payload.data?.channel_id ?? payload.broadcast?.channel_id;
    if (!channelId) {
      logVerboseMessage("mattermost: drop post (missing channel id)");
      return;
    }
    const allMessageIds = messageIds?.length ? messageIds : post.id ? [post.id] : [];
    if (allMessageIds.length === 0) {
      logVerboseMessage("mattermost: drop post (missing message id)");
      return;
    }
    const dedupeEntries = allMessageIds.map(
      (id) => recentInboundMessages.check(`${account.accountId}:${id}`)
    );
    if (dedupeEntries.length > 0 && dedupeEntries.every(Boolean)) {
      logVerboseMessage(
        `mattermost: drop post (dedupe account=${account.accountId} ids=${allMessageIds.length})`
      );
      return;
    }
    const senderId = post.user_id ?? payload.broadcast?.user_id;
    if (!senderId) {
      logVerboseMessage("mattermost: drop post (missing sender id)");
      return;
    }
    if (senderId === botUserId) {
      logVerboseMessage(`mattermost: drop post (self sender=${senderId})`);
      return;
    }
    if (isSystemPost(post)) {
      logVerboseMessage(`mattermost: drop post (system post type=${post.type ?? "unknown"})`);
      return;
    }
    const channelInfo = await resolveChannelInfo(channelId);
    const channelType = payload.data?.channel_type ?? channelInfo?.type ?? void 0;
    const kind = mapMattermostChannelTypeToChatType(channelType);
    const chatType = channelChatType(kind);
    const senderName = payload.data?.sender_name?.trim() || (await resolveUserInfo(senderId))?.username?.trim() || senderId;
    const rawText = post.message?.trim() || "";
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const normalizedAllowFrom = normalizeMattermostAllowList(account.config.allowFrom ?? []);
    const normalizedGroupAllowFrom = normalizeMattermostAllowList(
      account.config.groupAllowFrom ?? []
    );
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        provider: "mattermost",
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy
      })
    );
    const accessDecision = resolveDmGroupAccessWithLists({
      isGroup: kind !== "direct",
      dmPolicy,
      groupPolicy,
      allowFrom: normalizedAllowFrom,
      groupAllowFrom: normalizedGroupAllowFrom,
      storeAllowFrom,
      isSenderAllowed: (allowFrom) => isMattermostSenderAllowed({
        senderId,
        senderName,
        allowFrom,
        allowNameMatching
      })
    });
    const effectiveAllowFrom = accessDecision.effectiveAllowFrom;
    const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost"
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
    const isControlCommand = allowTextCommands && hasControlCommand;
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const commandDmAllowFrom = kind === "direct" ? effectiveAllowFrom : normalizedAllowFrom;
    const senderAllowedForCommands = isMattermostSenderAllowed({
      senderId,
      senderName,
      allowFrom: commandDmAllowFrom,
      allowNameMatching
    });
    const groupAllowedForCommands = isMattermostSenderAllowed({
      senderId,
      senderName,
      allowFrom: effectiveGroupAllowFrom,
      allowNameMatching
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: commandDmAllowFrom.length > 0, allowed: senderAllowedForCommands },
        {
          configured: effectiveGroupAllowFrom.length > 0,
          allowed: groupAllowedForCommands
        }
      ],
      allowTextCommands,
      hasControlCommand
    });
    const commandAuthorized = commandGate.commandAuthorized;
    if (accessDecision.decision !== "allow") {
      if (kind === "direct") {
        if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
          logVerboseMessage(`mattermost: drop dm (dmPolicy=disabled sender=${senderId})`);
          return;
        }
        if (accessDecision.decision === "pairing") {
          const { code, created } = await pairing.upsertPairingRequest({
            id: senderId,
            meta: { name: senderName }
          });
          logVerboseMessage(`mattermost: pairing request sender=${senderId} created=${created}`);
          if (created) {
            try {
              await sendMessageMattermost(
                `user:${senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "mattermost",
                  idLine: `Your Mattermost user id: ${senderId}`,
                  code
                }),
                { accountId: account.accountId }
              );
              opts.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerboseMessage(`mattermost: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
          return;
        }
        logVerboseMessage(`mattermost: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
        logVerboseMessage("mattermost: drop group message (groupPolicy=disabled)");
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
        logVerboseMessage("mattermost: drop group message (no group allowlist)");
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
        logVerboseMessage(`mattermost: drop group sender=${senderId} (not in groupAllowFrom)`);
        return;
      }
      logVerboseMessage(
        `mattermost: drop group message (groupPolicy=${groupPolicy} reason=${accessDecision.reason})`
      );
      return;
    }
    if (kind !== "direct" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "mattermost",
        reason: "control command (unauthorized)",
        target: senderId
      });
      return;
    }
    const teamId = payload.data?.team_id ?? channelInfo?.team_id ?? void 0;
    const channelName = payload.data?.channel_name ?? channelInfo?.name ?? "";
    const channelDisplay = payload.data?.channel_display_name ?? channelInfo?.display_name ?? channelName;
    const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? senderId : channelId
      }
    });
    const baseSessionKey = route.sessionKey;
    const threadRootId = post.root_id?.trim() || void 0;
    const replyToMode = resolveMattermostReplyToMode(account, kind);
    const threadContext = resolveMattermostThreadSessionContext({
      baseSessionKey,
      kind,
      postId: post.id,
      replyToMode,
      threadRootId
    });
    const { effectiveReplyToId, sessionKey, parentSessionKey } = threadContext;
    const historyKey = kind === "direct" ? null : sessionKey;
    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
    const wasMentioned = kind !== "direct" && ((botUsername ? rawText.toLowerCase().includes(`@${botUsername.toLowerCase()}`) : false) || core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
    const pendingBody = rawText || (post.file_ids?.length ? `[Mattermost ${post.file_ids.length === 1 ? "file" : "files"}]` : "");
    const pendingSender = senderName;
    const recordPendingHistory = () => {
      const trimmed = pendingBody.trim();
      recordPendingHistoryEntryIfEnabled({
        historyMap: channelHistories,
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry: historyKey && trimmed ? {
          sender: pendingSender,
          body: trimmed,
          timestamp: typeof post.create_at === "number" ? post.create_at : void 0,
          messageId: post.id ?? void 0
        } : null
      });
    };
    const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
    const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
    const oncharResult = oncharEnabled ? stripOncharPrefix(rawText, oncharPrefixes) : { triggered: false, stripped: rawText };
    const oncharTriggered = oncharResult.triggered;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
    const mentionDecision = evaluateMattermostMentionGate({
      kind,
      cfg,
      accountId: account.accountId,
      channelId,
      threadRootId,
      requireMentionOverride: account.requireMention,
      resolveRequireMention: core.channel.groups.resolveRequireMention,
      wasMentioned,
      isControlCommand,
      commandAuthorized,
      oncharEnabled,
      oncharTriggered,
      canDetectMention
    });
    const { shouldRequireMention, shouldBypassMention } = mentionDecision;
    if (mentionDecision.dropReason === "onchar-not-triggered") {
      logVerboseMessage(
        `mattermost: drop group message (onchar not triggered channel=${channelId} sender=${senderId})`
      );
      recordPendingHistory();
      return;
    }
    if (mentionDecision.dropReason === "missing-mention") {
      logVerboseMessage(
        `mattermost: drop group message (missing mention channel=${channelId} sender=${senderId} requireMention=${shouldRequireMention} bypass=${shouldBypassMention} canDetectMention=${canDetectMention})`
      );
      recordPendingHistory();
      return;
    }
    const mediaList = await resolveMattermostMedia(post.file_ids);
    const mediaPlaceholder = buildMattermostAttachmentPlaceholder(mediaList);
    const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
    const baseText = [bodySource, mediaPlaceholder].filter(Boolean).join("\n").trim();
    const bodyText = normalizeMention(baseText, botUsername);
    if (!bodyText) {
      logVerboseMessage(
        `mattermost: drop group message (empty body after normalization channel=${channelId} sender=${senderId})`
      );
      return;
    }
    core.channel.activity.record({
      channel: "mattermost",
      accountId: account.accountId,
      direction: "inbound"
    });
    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "direct",
      groupLabel: channelDisplay || roomLabel,
      groupId: channelId,
      groupFallback: roomLabel || "Channel",
      directLabel: senderName,
      directId: senderId
    });
    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = kind === "direct" ? `Mattermost DM from ${senderName}` : `Mattermost message in ${roomLabel} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `mattermost:message:${channelId}:${post.id ?? "unknown"}`
    });
    const textWithId = `${bodyText}
[mattermost message id: ${post.id ?? "unknown"} channel: ${channelId}]`;
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Mattermost",
      from: fromLabel,
      timestamp: typeof post.create_at === "number" ? post.create_at : void 0,
      body: textWithId,
      chatType,
      sender: { name: senderName, id: senderId }
    });
    let combinedBody = body;
    if (historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) => core.channel.reply.formatInboundEnvelope({
          channel: "Mattermost",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""}`,
          chatType,
          senderLabel: entry.sender
        })
      });
    }
    const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
    const mediaPayload = buildAgentMediaPayload(mediaList);
    const commandBody = rawText.trim();
    const inboundHistory = historyKey && historyLimit > 0 ? (channelHistories.get(historyKey) ?? []).map((entry) => ({
      sender: entry.sender,
      body: entry.body,
      timestamp: entry.timestamp
    })) : void 0;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: bodyText,
      InboundHistory: inboundHistory,
      RawBody: bodyText,
      CommandBody: commandBody,
      BodyForCommands: commandBody,
      From: kind === "direct" ? `mattermost:${senderId}` : kind === "group" ? `mattermost:group:${channelId}` : `mattermost:channel:${channelId}`,
      To: to,
      SessionKey: sessionKey,
      ParentSessionKey: parentSessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : void 0,
      GroupChannel: channelName ? `#${channelName}` : void 0,
      GroupSpace: teamId,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "mattermost",
      Surface: "mattermost",
      MessageSid: post.id ?? void 0,
      MessageSids: allMessageIds.length > 1 ? allMessageIds : void 0,
      MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : void 0,
      MessageSidLast: allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : void 0,
      ReplyToId: effectiveReplyToId,
      MessageThreadId: effectiveReplyToId,
      Timestamp: typeof post.create_at === "number" ? post.create_at : void 0,
      WasMentioned: kind !== "direct" ? mentionDecision.effectiveWasMentioned : void 0,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "mattermost",
      OriginatingTo: to,
      ...mediaPayload
    });
    if (kind === "direct") {
      const sessionCfg = cfg.session;
      const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId
      });
      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "mattermost",
          to,
          accountId: route.accountId
        }
      });
    }
    const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
    logVerboseMessage(
      `mattermost inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`
    );
    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "mattermost",
      account.accountId,
      {
        fallbackLimit: account.textChunkLimit ?? 4e3
      }
    );
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "mattermost",
      accountId: account.accountId
    });
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "mattermost",
      accountId: account.accountId
    });
    const typingCallbacks = createTypingCallbacks({
      start: () => sendTypingIndicator(channelId, effectiveReplyToId),
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => logger.debug?.(message),
          channel: "mattermost",
          target: channelId,
          error: err
        });
      }
    });
    const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      typingCallbacks,
      deliver: async (payload2) => {
        await deliverMattermostReplyPayload({
          core,
          cfg,
          payload: payload2,
          to,
          accountId: account.accountId,
          agentId: route.agentId,
          replyToId: resolveMattermostReplyRootId({
            threadRootId: effectiveReplyToId,
            replyToId: payload2.replyToId
          }),
          textLimit,
          tableMode,
          sendMessage: sendMessageMattermost
        });
        runtime.log?.(`delivered reply to ${to}`);
      },
      onError: (err, info) => {
        runtime.error?.(`mattermost ${info.kind} reply failed: ${String(err)}`);
      }
    });
    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markDispatchIdle();
      },
      run: () => core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming: typeof account.blockStreaming === "boolean" ? !account.blockStreaming : void 0,
          onModelSelected
        }
      })
    });
    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit
      });
    }
  };
  const handleReactionEvent = async (payload) => {
    const reactionData = payload.data?.reaction;
    if (!reactionData) {
      return;
    }
    let reaction = null;
    if (typeof reactionData === "string") {
      try {
        reaction = JSON.parse(reactionData);
      } catch {
        return;
      }
    } else if (typeof reactionData === "object") {
      reaction = reactionData;
    }
    if (!reaction) {
      return;
    }
    const userId = reaction.user_id?.trim();
    const postId = reaction.post_id?.trim();
    const emojiName = reaction.emoji_name?.trim();
    if (!userId || !postId || !emojiName) {
      return;
    }
    if (userId === botUserId) {
      return;
    }
    const isRemoved = payload.event === "reaction_removed";
    const action = isRemoved ? "removed" : "added";
    const senderInfo = await resolveUserInfo(userId);
    const senderName = senderInfo?.username?.trim() || userId;
    const channelId = payload.broadcast?.channel_id;
    if (!channelId) {
      logVerboseMessage(
        `mattermost: drop reaction (no channel_id in broadcast, cannot enforce policy)`
      );
      return;
    }
    const channelInfo = await resolveChannelInfo(channelId);
    if (!channelInfo?.type) {
      logVerboseMessage(`mattermost: drop reaction (cannot resolve channel type for ${channelId})`);
      return;
    }
    const kind = mapMattermostChannelTypeToChatType(channelInfo.type);
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        provider: "mattermost",
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy
      })
    );
    const reactionAccess = resolveDmGroupAccessWithLists({
      isGroup: kind !== "direct",
      dmPolicy,
      groupPolicy,
      allowFrom: normalizeMattermostAllowList(account.config.allowFrom ?? []),
      groupAllowFrom: normalizeMattermostAllowList(account.config.groupAllowFrom ?? []),
      storeAllowFrom,
      isSenderAllowed: (allowFrom) => isMattermostSenderAllowed({
        senderId: userId,
        senderName,
        allowFrom,
        allowNameMatching
      })
    });
    if (reactionAccess.decision !== "allow") {
      if (kind === "direct") {
        logVerboseMessage(
          `mattermost: drop reaction (dmPolicy=${dmPolicy} sender=${userId} reason=${reactionAccess.reason})`
        );
      } else {
        logVerboseMessage(
          `mattermost: drop reaction (groupPolicy=${groupPolicy} sender=${userId} reason=${reactionAccess.reason} channel=${channelId})`
        );
      }
      return;
    }
    const teamId = channelInfo?.team_id ?? void 0;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? userId : channelId
      }
    });
    const sessionKey = route.sessionKey;
    const eventText = `Mattermost reaction ${action}: :${emojiName}: by @${senderName} on post ${postId} in channel ${channelId}`;
    core.system.enqueueSystemEvent(eventText, {
      sessionKey,
      contextKey: `mattermost:reaction:${postId}:${emojiName}:${userId}:${action}`
    });
    logVerboseMessage(
      `mattermost reaction: ${action} :${emojiName}: by ${senderName} on ${postId}`
    );
  };
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "mattermost"
  });
  const debouncer = core.channel.debounce.createInboundDebouncer({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const channelId = entry.post.channel_id ?? entry.payload.data?.channel_id ?? entry.payload.broadcast?.channel_id;
      if (!channelId) {
        return null;
      }
      const threadId = entry.post.root_id?.trim();
      const threadKey = threadId ? `thread:${threadId}` : "channel";
      return `mattermost:${account.accountId}:${channelId}:${threadKey}`;
    },
    shouldDebounce: (entry) => {
      if (entry.post.file_ids && entry.post.file_ids.length > 0) {
        return false;
      }
      const text = entry.post.message?.trim() ?? "";
      if (!text) {
        return false;
      }
      return !core.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handlePost(last.post, last.payload);
        return;
      }
      const combinedText = entries.map((entry) => entry.post.message?.trim() ?? "").filter(Boolean).join("\n");
      const mergedPost = {
        ...last.post,
        message: combinedText,
        file_ids: []
      };
      const ids = entries.map((entry) => entry.post.id).filter(Boolean);
      await handlePost(mergedPost, last.payload, ids.length > 0 ? ids : void 0);
    },
    onError: (err) => {
      runtime.error?.(`mattermost debounce flush failed: ${String(err)}`);
    }
  });
  const wsUrl = buildMattermostWsUrl(baseUrl);
  let seq = 1;
  const connectOnce = createMattermostConnectOnce({
    wsUrl,
    botToken,
    abortSignal: opts.abortSignal,
    statusSink: opts.statusSink,
    runtime,
    webSocketFactory: opts.webSocketFactory,
    nextSeq: () => seq++,
    onPosted: async (post, payload) => {
      await debouncer.enqueue({ post, payload });
    },
    onReaction: async (payload) => {
      await handleReactionEvent(payload);
    }
  });
  let slashShutdownCleanup = null;
  if (slashEnabled) {
    const runAbortCleanup = () => {
      if (slashShutdownCleanup) {
        return;
      }
      const commands = getSlashCommandState(account.accountId)?.registeredCommands ?? [];
      deactivateSlashCommands(account.accountId);
      slashShutdownCleanup = cleanupSlashCommands({
        client,
        commands,
        log: (msg) => runtime.log?.(msg)
      }).catch((err) => {
        runtime.error?.(`mattermost: slash cleanup failed: ${String(err)}`);
      });
    };
    if (opts.abortSignal?.aborted) {
      runAbortCleanup();
    } else {
      opts.abortSignal?.addEventListener("abort", runAbortCleanup, { once: true });
    }
  }
  try {
    await runWithReconnect(connectOnce, {
      abortSignal: opts.abortSignal,
      jitterRatio: 0.2,
      onError: (err) => {
        runtime.error?.(`mattermost connection failed: ${String(err)}`);
        opts.statusSink?.({ lastError: String(err), connected: false });
      },
      onReconnect: (delayMs) => {
        runtime.log?.(`mattermost reconnecting in ${Math.round(delayMs / 1e3)}s`);
      }
    });
  } finally {
    unregisterInteractions?.();
  }
  if (slashShutdownCleanup) {
    await slashShutdownCleanup;
  }
}
export {
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
  monitorMattermostProvider,
  resolveMattermostEffectiveReplyToId,
  resolveMattermostReplyRootId,
  resolveMattermostThreadSessionContext
};
