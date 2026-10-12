import type {
  AllMiddlewareArgs,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackCommandMiddlewareArgs,
  SlackOptionsMiddlewareArgs,
} from "@slack/bolt";
import { loadPreparedModelCatalog, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  listNativeCommandSpecsForConfig,
  prepareSkillCommandsForAgents,
  parseCommandArgs,
  resolveCommandArgMenuAsync,
  type CommandArgs,
  resolveNativeCommandSessionTargets,
} from "openclaw/plugin-sdk/command-auth-native";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import {
  mergeNativeCommandSpecs,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/native-command-registry";
import type {
  PluginCommandCatalogDecision,
  PluginCommandNativeCandidate,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkItems } from "openclaw/plugin-sdk/text-chunking";
import { resolveSlackAccount, type ResolvedSlackAccount } from "../accounts.js";
import { buildSlackCompleteBlocksFallbackText } from "../blocks-fallback.js";
import { SLACK_MAX_BLOCKS } from "../blocks-input.js";
import { requireSlackPostMessageTimestamp } from "../client-delivery.js";
import { formatSlackError } from "../errors.js";
import { truncateSlackText } from "../truncate.js";
import { resolveSlackCommandIngress, resolveSlackEffectiveAllowFrom } from "./auth.js";
import { resolveSlackChannelConfig, type SlackChannelConfigResolved } from "./channel-config.js";
import { buildSlackSlashCommandMatcher, resolveSlackSlashCommandConfig } from "./commands.js";
import {
  normalizeSlackChannelType,
  resolveSlackChatType,
  type SlackMonitorContext,
} from "./context.js";
import { resolveSlackDeferredActionTarget } from "./deferred-action-routing.js";
import { authorizeSlackDirectMessage } from "./dm-auth.js";
import { resolveSlackMonitorEventScope } from "./event-scope.js";
import {
  createSlackExternalArgMenuStore,
  SLACK_EXTERNAL_ARG_MENU_PREFIX,
  type SlackExternalArgMenuChoice,
} from "./external-arg-menu-store.js";
import { resolveSlackSenderAuthentication } from "./ingress.js";
import { resolveSlackSessionEventRoutingContext } from "./message-handler/prepare-routing.js";
import { escapeSlackMrkdwn } from "./mrkdwn.js";
import {
  createSlackResponseUrlBudget,
  SlackResponseAlreadyReportedError,
} from "./response-url-budget.js";
import { resolveSlackRoomContextHints } from "./room-context.js";
import { captureSlackSessionTargetGuard } from "./session-run-targets.js";
import { resolveSlackCommandMenuModelContext } from "./slash-menu-model-context.js";
import type { SlackCommandInvocation } from "./types.js";

const SLACK_COMMAND_ARG_ACTION_ID = "openclaw_cmdarg";
const SLACK_COMMAND_ARG_ACTION_LISTENER = /^openclaw_cmdarg/;
const SLACK_COMMAND_ARG_VALUE_PREFIX = "cmdarg";
const SLACK_COMMAND_ARG_BUTTON_ROW_SIZE = 5;
const SLACK_COMMAND_ARG_OVERFLOW_MIN = 3;
const SLACK_COMMAND_ARG_OVERFLOW_MAX = 5;
const SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX = 100;
const SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX = 75;
const SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX = 150;
const SLACK_COMMAND_ARG_BUTTON_TEXT_MAX = 75;
const SLACK_COMMAND_ARG_BUTTON_VALUE_MAX = 2000;
const SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX = 300;
const SLACK_HEADER_TEXT_MAX = 150;
const SLACK_COMMAND_ARG_CHROME_BLOCKS = 3;
const SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX = SLACK_MAX_BLOCKS - SLACK_COMMAND_ARG_CHROME_BLOCKS;

type SlackCommandHandlerArgs = SlackCommandMiddlewareArgs &
  Pick<AllMiddlewareArgs, "context" | "client">;
type SlackArgActionHandlerArgs = Omit<SlackActionMiddlewareArgs<BlockAction>, "respond"> &
  Pick<AllMiddlewareArgs, "context" | "client"> & {
    // Bolt only supplies respond when the action has a response URL.
    respond?: SlackActionMiddlewareArgs<BlockAction>["respond"];
  };
type SlackArgOptionsHandlerArgs = SlackOptionsMiddlewareArgs<"block_suggestion"> &
  Pick<AllMiddlewareArgs, "context" | "client">;

const loadSlashDispatchRuntime = createLazyRuntimeModule(
  () => import("./slash-dispatch.runtime.js"),
);

const loadPluginCommandRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/plugin-command-runtime"),
);

const slackExternalArgMenuStore = createSlackExternalArgMenuStore();

function buildSlackArgMenuConfirm(params: { command: string; arg: string }) {
  const command = escapeSlackMrkdwn(params.command);
  const arg = escapeSlackMrkdwn(params.arg);
  return {
    title: { type: "plain_text", text: "Confirm selection" },
    text: {
      type: "mrkdwn",
      text: truncateSlackText(
        `Run */${command}* with *${arg}* set to this value?`,
        SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX,
      ),
    },
    confirm: { type: "plain_text", text: "Run command" },
    deny: { type: "plain_text", text: "Cancel" },
  };
}

function encodeSlackCommandArgValue(parts: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}) {
  return [
    SLACK_COMMAND_ARG_VALUE_PREFIX,
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

function parseSlackCommandArgValue(raw?: string | null): {
  command: string;
  arg: string;
  value: string;
  userId: string;
} | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split("|");
  if (parts.length !== 5 || parts[0] !== SLACK_COMMAND_ARG_VALUE_PREFIX) {
    return null;
  }
  try {
    const [command, arg, value, userId] = parts.slice(1).map(decodeURIComponent);
    return command && arg && value && userId ? { command, arg, value, userId } : null;
  } catch {
    return null;
  }
}

function buildSlackArgMenuOptions(choices: SlackExternalArgMenuChoice[]) {
  return choices.map((choice) => ({
    text: {
      type: "plain_text" as const,
      text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX),
    },
    value: choice.value,
  }));
}

function buildSlackCommandArgMenuBlocks(params: {
  title: string;
  command: string;
  arg: string;
  choices: Array<{ value: string; label: string }>;
  userId: string;
  supportsExternalSelect: boolean;
  createExternalMenuToken: (choices: SlackExternalArgMenuChoice[]) => string;
}) {
  const encodedChoices = params.choices.map((choice) => ({
    label: choice.label,
    value: encodeSlackCommandArgValue({
      command: params.command,
      arg: params.arg,
      value: choice.value,
      userId: params.userId,
    }),
  }));
  const canUseStaticSelect = encodedChoices.every(
    (choice) => choice.value.length <= SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX,
  );
  const canUseOverflow =
    canUseStaticSelect &&
    encodedChoices.length >= SLACK_COMMAND_ARG_OVERFLOW_MIN &&
    encodedChoices.length <= SLACK_COMMAND_ARG_OVERFLOW_MAX;
  const canUseExternalSelect =
    params.supportsExternalSelect &&
    canUseStaticSelect &&
    encodedChoices.length > SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX;
  const confirm = buildSlackArgMenuConfirm({ command: params.command, arg: params.arg });
  const selectElement = { action_id: SLACK_COMMAND_ARG_ACTION_ID, confirm };
  const rows = canUseOverflow
    ? [
        {
          elements: [
            {
              ...selectElement,
              type: "overflow",
              options: buildSlackArgMenuOptions(encodedChoices),
            },
          ],
        },
      ]
    : canUseExternalSelect
      ? [
          {
            block_id: `${SLACK_EXTERNAL_ARG_MENU_PREFIX}${params.createExternalMenuToken(encodedChoices)}`,
            elements: [
              {
                ...selectElement,
                type: "external_select",
                min_query_length: 0,
                placeholder: { type: "plain_text", text: `Search ${params.arg}` },
              },
            ],
          },
        ]
      : encodedChoices.length <= SLACK_COMMAND_ARG_BUTTON_ROW_SIZE || !canUseStaticSelect
        ? chunkItems(
            encodedChoices.filter(
              (choice) => choice.value.length <= SLACK_COMMAND_ARG_BUTTON_VALUE_MAX,
            ),
            SLACK_COMMAND_ARG_BUTTON_ROW_SIZE,
          ).map((choices, rowIndex) => ({
            elements: choices.map((choice, colIndex) => ({
              type: "button",
              action_id: `${SLACK_COMMAND_ARG_ACTION_ID}_${rowIndex}_${colIndex}`,
              text: {
                type: "plain_text",
                text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_BUTTON_TEXT_MAX),
              },
              value: choice.value,
              confirm,
            })),
          }))
        : chunkItems(encodedChoices, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map(
            (choices, index) => ({
              elements: [
                {
                  ...selectElement,
                  type: "static_select",
                  placeholder: {
                    type: "plain_text",
                    text:
                      index === 0 ? `Choose ${params.arg}` : `Choose ${params.arg} (${index + 1})`,
                  },
                  options: buildSlackArgMenuOptions(choices),
                },
              ],
            }),
          );
  const headerText = truncateSlackText(
    `/${params.command}: choose ${params.arg}`,
    SLACK_HEADER_TEXT_MAX,
  );
  const sectionText = truncateSlackText(params.title, 3000);
  const contextText = truncateSlackText(
    `Select one option to continue /${params.command} (${params.arg})`,
    3000,
  );
  const visibleRows = rows.slice(0, SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX);
  return [
    {
      type: "header",
      text: { type: "plain_text", text: headerText },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: sectionText },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextText }],
    },
    ...visibleRows.map((row) => Object.assign({ type: "actions" }, row)),
  ];
}

type SlackCommandRegistration =
  | { mode: "single"; name: string }
  | { mode: "native" }
  | { mode: "disabled" };

type SlackNativeCommandSpec = NativeCommandSpec | PluginCommandNativeCandidate;
const NON_PLUGIN_COMMAND_DISPATCH = Object.freeze({
  kind: "non-plugin" as const,
}) satisfies PluginCommandCatalogDecision;

export function createSlackCommandHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  trackEvent?: () => void;
  supportsExternalArgMenus?: () => boolean;
}) {
  const { ctx: monitor, account: startupAccount, trackEvent } = params;
  const runtime = monitor.runtime;
  const supportsInteractiveArgMenus = typeof monitor.app.action === "function";
  const slashCommand = resolveSlackSlashCommandConfig(
    monitor.slashCommand ?? startupAccount.config.slashCommand,
  );

  return async (p: SlackCommandInvocation) => {
    const {
      command,
      ack,
      respond: respondWithoutBudget,
      body,
      eventScope,
      prompt,
      commandArgs,
      commandDefinition,
      pluginCommandReplyOptions,
    } = p;
    const responseBudget =
      p.responseTransport === "web-api"
        ? {
            respond: respondWithoutBudget,
            remaining: () => undefined,
          }
        : createSlackResponseUrlBudget(respondWithoutBudget);
    const respond = responseBudget.respond;
    const respondEphemeral = (text: string) => respond({ text, response_type: "ephemeral" });
    let cfg = monitor.cfg;
    try {
      if (monitor.shouldDropMismatchedSlackEvent?.(body)) {
        await ack();
        runtime.log?.(
          `slack: drop slash command from user=${command.user_id ?? "unknown"} channel=${command.channel_id ?? "unknown"} (mismatched app/team)`,
        );
        return false;
      }
      trackEvent?.();
      if (!prompt.trim()) {
        await ack({
          text: "Message required.",
          response_type: "ephemeral",
        });
        return false;
      }
      await ack();
      const ctx = await monitor.readRuntimeContext();
      cfg = ctx.cfg;
      const account = resolveSlackAccount({ cfg, accountId: params.account.accountId });

      if (ctx.botUserId && command.user_id === ctx.botUserId) {
        return false;
      }

      const channelInfo = await ctx.resolveChannelName(command.channel_id, eventScope);
      const rawChannelType =
        channelInfo?.type ?? (command.channel_name === "directmessage" ? "im" : undefined);
      const channelType = normalizeSlackChannelType(rawChannelType, command.channel_id);
      const chatType = resolveSlackChatType(channelType);
      const isDirectMessage = channelType === "im";
      const isGroupDm = channelType === "mpim";
      const isRoom = channelType === "channel" || channelType === "group";
      const isRoomish = isRoom || isGroupDm;

      if (
        !ctx.isChannelAllowed({
          teamId: eventScope?.teamId ?? ctx.teamId,
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channelType,
        })
      ) {
        await respondEphemeral("This channel is not allowed.");
        return false;
      }

      const effectiveAllowFromLower = await resolveSlackEffectiveAllowFrom(ctx, {
        includePairingStore: isDirectMessage,
        eventScope,
      });

      // Privileged command surface: compute CommandAuthorized, don't assume true.
      // Keep this aligned with the Slack message path (message-handler/prepare.ts).
      let channelConfig: SlackChannelConfigResolved | null = null;
      if (isDirectMessage) {
        const allowed = await authorizeSlackDirectMessage({
          ctx,
          accountId: ctx.accountId,
          senderId: command.user_id,
          eventScope,
          allowFromLower: effectiveAllowFromLower,
          resolveSenderName: (userId) => ctx.resolveUserName(userId, eventScope),
          sendPairingReply: async (text) => {
            await respondEphemeral(text);
          },
          onDisabled: async () => {
            await respondEphemeral("Slack DMs are disabled.");
          },
          onUnauthorized: async ({ allowMatchMeta }) => {
            logVerbose(
              `slack: blocked slash sender ${command.user_id} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`,
            );
            await respondEphemeral("You are not authorized to use this command.");
          },
          log: logVerbose,
        });
        if (!allowed) {
          return false;
        }
      }

      if (isRoom) {
        channelConfig = resolveSlackChannelConfig({
          teamId: eventScope?.teamId ?? ctx.teamId,
          allowUnscoped: ctx.installationIdentity?.kind !== "enterprise",
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channels: ctx.channelsConfig,
          channelKeys: ctx.channelsConfigKeys,
          defaultRequireMention: ctx.defaultRequireMention,
          allowNameMatching: ctx.allowNameMatching,
        });
      }

      const sender = await ctx.resolveUserName(command.user_id, eventScope);
      const senderName = sender?.name ?? command.user_name ?? command.user_id;
      const slashIngress = await resolveSlackCommandIngress({
        ctx,
        teamId: eventScope?.teamId ?? ctx.teamId,
        senderId: command.user_id,
        senderAuthentication: p.senderAuthentication,
        senderName,
        channelType: channelType ?? "channel",
        channelId: command.channel_id,
        threadId: p.threadTs,
        ownerAllowFromLower: effectiveAllowFromLower,
        channelUsers: isRoom ? channelConfig?.users : undefined,
        allowTextCommands: false,
        hasControlCommand: false,
        eventKind: "slash-command",
        modeWhenAccessGroupsOff: "configured",
      });
      const senderGate = slashIngress.senderAccess.gate;
      if (isRoomish && senderGate?.allowed === false) {
        await respondEphemeral("You are not authorized to use this command here.");
        return false;
      }

      // DMs: allow chatting in dmPolicy=open, but keep privileged command gating intact by setting
      // CommandAuthorized based on allowlists/access-groups (downstream decides which commands need it).
      const commandAuthorized = slashIngress.commandAccess.authorized;
      if (isRoomish && ctx.useAccessGroups && !commandAuthorized) {
        await respondEphemeral("You are not authorized to use this command.");
        return false;
      }

      const routeTarget = resolveSlackDeferredActionTarget({
        eventScope,
        kind: isDirectMessage ? "user" : "channel",
        id: isDirectMessage ? command.user_id : command.channel_id,
      });
      const routingTeamId = (eventScope?.teamId ?? ctx.teamId) || undefined;
      let resolvedSlashRoute: ResolvedAgentRoute | undefined;
      let isCurrentSession = p.isSessionTargetCurrent;
      const resolveSlashRoute = async () => {
        if (resolvedSlashRoute) {
          return resolvedSlashRoute;
        }
        if (p.threadTs) {
          if (p.sessionTarget) {
            resolvedSlashRoute = p.sessionTarget;
            isCurrentSession = await captureSlackSessionTargetGuard(
              ctx,
              p.sessionTarget,
              p.isSessionTargetCurrent,
            );
            return resolvedSlashRoute;
          }
          const routing = await resolveSlackSessionEventRoutingContext({
            intent: "stop",
            ctx,
            account,
            message: {
              type: "message",
              channel: command.channel_id,
              user: command.user_id,
              ts: p.eventTs,
              thread_ts: p.threadTs,
            },
            chatType,
            channelConfig,
            eventScope,
          });
          resolvedSlashRoute = routing.route;
          isCurrentSession = routing.isCurrentSession;
          return resolvedSlashRoute;
        }
        const { resolveAgentRoute } = await loadSlashDispatchRuntime();
        resolvedSlashRoute = resolveAgentRoute({
          cfg,
          channel: "slack",
          accountId: account.accountId,
          teamId: routingTeamId,
          peer: {
            kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
            id: routeTarget.peerId,
          },
        });
        return resolvedSlashRoute;
      };

      if (commandDefinition && supportsInteractiveArgMenus) {
        const menuNeedsModelContext =
          !(commandArgs?.raw && !commandArgs.values) &&
          commandDefinition.args?.some(
            (arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null,
          );
        const menuRoute =
          menuNeedsModelContext || commandDefinition.key === "verbose"
            ? await resolveSlashRoute()
            : undefined;
        const menuModelContext =
          menuNeedsModelContext && menuRoute
            ? await resolveSlackCommandMenuModelContext({
                cfg,
                agentId: menuRoute.agentId,
                sessionKey: menuRoute.sessionKey,
              })
            : {};
        // Native /think must not wait on provider discovery; persisted rows retain its metadata.
        const menuModelCatalog =
          commandDefinition.key === "think" && menuNeedsModelContext
            ? await loadPreparedModelCatalog({
                config: cfg,
                ...(menuRoute
                  ? {
                      agentId: menuRoute.agentId,
                      agentDir: resolveAgentDir(cfg, menuRoute.agentId),
                    }
                  : {}),
                readOnly: true,
              })
            : undefined;
        const menu = await resolveCommandArgMenuAsync({
          command: commandDefinition,
          args: commandArgs,
          cfg,
          session: menuRoute,
          ...menuModelContext,
          catalog: menuModelCatalog,
        });
        if (menu) {
          const route = menuRoute ?? (await resolveSlashRoute());
          const commandLabel = commandDefinition.nativeName ?? commandDefinition.key;
          const title = formatCommandArgMenuTitle({ command: commandDefinition, menu });
          const blocks = buildSlackCommandArgMenuBlocks({
            title,
            command: commandLabel,
            arg: menu.arg.name,
            choices: menu.choices,
            userId: command.user_id,
            supportsExternalSelect: params.supportsExternalArgMenus?.() ?? false,
            createExternalMenuToken: (choices) =>
              slackExternalArgMenuStore.create({ choices, userId: command.user_id }),
          });
          await respond({
            text: title,
            blocks,
            response_type: "ephemeral",
          });
          const commandId = p.eventTs ?? command.trigger_id;
          if (commandId) {
            const { recordDeliveredCommandExchange } = await loadSlashDispatchRuntime();
            await recordDeliveredCommandExchange({
              config: cfg,
              agentId: route.agentId,
              sessionKey: route.sessionKey,
              assertCurrent: isCurrentSession,
              commandText: prompt,
              commandId: `slack:${account.accountId}:${routeTarget.peerId}:${commandId}`,
              replyId: "argument-menu",
              replyText: buildSlackCompleteBlocksFallbackText(blocks, {
                includeSelectOptions: true,
                nativeDataFormat: "plain",
              }),
            });
          }
          return false;
        }
      }

      const channelName = channelInfo?.name;
      const roomLabel = channelName ? `#${channelName}` : `#${command.channel_id}`;
      const {
        deliverSlackSlashReplies,
        dispatchChannelInboundTurn,
        finalizeInboundContext,
        isChannelPartialDeliveryError,
        resolveChunkMode,
        resolveConversationLabel,
        resolveMarkdownTableMode,
        sanitizeSlackMonitorReplyPayload,
      } = await loadSlashDispatchRuntime();

      const route = await resolveSlashRoute();

      const { channelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
        isRoomish,
        channelInfo,
        channelConfig,
      });

      const slashUserTarget = resolveSlackDeferredActionTarget({
        eventScope,
        kind: "user",
        id: command.user_id,
      });
      const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
        agentId: route.agentId,
        sessionPrefix: slashCommand.sessionPrefix,
        userId: slashUserTarget.peerId,
        targetSessionKey: route.sessionKey,
        sessionKeyCase: "lowercase",
      });
      const slashReplyTarget = resolveSlackDeferredActionTarget({
        eventScope,
        kind: !slashCommand.ephemeral && isRoomish ? "channel" : "user",
        id: !slashCommand.ephemeral && isRoomish ? command.channel_id : command.user_id,
      }).target;
      const from = isDirectMessage
        ? `slack:${routeTarget.peerId}`
        : isRoom
          ? `slack:channel:${routeTarget.peerId}`
          : `slack:group:${routeTarget.peerId}`;
      const ctxPayload = finalizeInboundContext({
        Body: prompt,
        BodyForAgent: prompt,
        RawBody: prompt,
        CommandBody: prompt,
        CommandArgs: commandArgs,
        From: from,
        To: `slash:${slashUserTarget.peerId}`,
        ChatType: chatType,
        ConversationLabel:
          resolveConversationLabel({
            ChatType: chatType,
            SenderName: senderName,
            GroupSubject: isRoomish ? roomLabel : undefined,
            From: from,
          }) ?? (isDirectMessage ? senderName : roomLabel),
        GroupSubject: isRoomish ? roomLabel : undefined,
        GroupSpace: routingTeamId,
        GroupSystemPrompt: groupSystemPrompt,
        ChannelPromptContext: channelMetadata ? [channelMetadata] : undefined,
        SenderName: senderName,
        SenderId: command.user_id,
        Provider: "slack" as const,
        Surface: "slack" as const,
        WasMentioned: true,
        MessageSid: p.eventTs ?? command.trigger_id,
        MessageThreadId: p.threadTs,
        Timestamp: Date.now(),
        SessionKey: sessionKey,
        CommandTargetSessionKey: commandTargetSessionKey,
        AccountId: route.accountId,
        CommandSource: "native" as const,
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "slack" as const,
        OriginatingTo: p.threadTs
          ? resolveSlackDeferredActionTarget({
              eventScope,
              kind: "channel",
              id: command.channel_id,
            }).target
          : slashReplyTarget,
      });

      const messageSentHookTarget = ctxPayload.OriginatingTo ?? ctxPayload.To ?? slashReplyTarget;
      const deliverSlashPayloads = async (
        replies: Parameters<typeof deliverSlackSlashReplies>[0]["replies"],
        onReplySettled?: Parameters<typeof deliverSlackSlashReplies>[0]["onReplySettled"],
      ) => {
        await deliverSlackSlashReplies({
          replies,
          respond,
          ephemeral: p.threadTs ? false : slashCommand.ephemeral,
          textLimit: ctx.textLimit,
          messageSentHookTarget,
          accountId: route.accountId,
          sessionKeyForInternalHooks: ctxPayload.SessionKey ?? route.sessionKey,
          isGroup: isRoomish,
          groupId: isRoomish ? command.channel_id : undefined,
          chunkMode: resolveChunkMode(cfg, "slack", route.accountId),
          tableMode: resolveMarkdownTableMode({
            cfg,
            channel: "slack",
            accountId: route.accountId,
          }),
          responseBudget,
          onReplySettled,
        });
      };
      const pendingSlashReplies: Array<{
        payload: Parameters<typeof deliverSlackSlashReplies>[0]["replies"][number];
        finalization: ReturnType<typeof createDeferred<{ visibleReplySent: boolean }>>;
      }> = [];
      const shouldDeliverBlockImmediately = commandDefinition?.key === "login";

      const builtInDispatch = p.builtInCommand
        ? {
            [(await loadPluginCommandRuntime()).PLUGIN_COMMAND_DISPATCH]:
              NON_PLUGIN_COMMAND_DISPATCH,
          }
        : undefined;
      if (commandAuthorized) {
        if (isCurrentSession?.() === false || p.onAdmitted?.() === false) {
          await respondEphemeral("The selected run has already finished.");
          return false;
        }
      }
      await dispatchChannelInboundTurn({
        cfg,
        channel: "slack",
        accountId: route.accountId,
        route: {
          agentId: route.agentId,
          sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        },
        ctxPayload,
        dispatchReplyFromConfig: ctx.dispatchReplyFromConfig,
        replyPipeline: { transformReplyPayload: sanitizeSlackMonitorReplyPayload },
        dispatcherOptions: {
          // /login must expose its device code before the auth flow can finish. Other block
          // streams stay batched so the response_url planner can honor Slack's five-call cap.
          onSettled: async () => {
            if (pendingSlashReplies.length === 0) {
              return;
            }
            const pending = pendingSlashReplies.splice(0);
            try {
              await deliverSlashPayloads(
                pending.map((entry) => entry.payload),
                ({ replyIndex, visibleReplySent, error }) => {
                  const entry = pending[replyIndex];
                  if (!entry) {
                    return;
                  }
                  if (error !== undefined) {
                    entry.finalization.reject(error);
                    return;
                  }
                  entry.finalization.resolve({ visibleReplySent });
                },
              );
            } catch (error) {
              const unsettledError = isChannelPartialDeliveryError(error)
                ? (error.cause ?? error)
                : error;
              // Settled promises retain their outcome; reject the undispatched tail too.
              for (const entry of pending) {
                entry.finalization.reject(unsettledError);
              }
              throw error;
            }
          },
        },
        delivery: {
          // The response_url helper owns provider-finalized message_sent emission. Keep
          // observeMessageSent unset or core would emit a second lifecycle event.
          deliver: async (payload, info) => {
            if (info.kind === "block" && shouldDeliverBlockImmediately) {
              let visibleReplySent = false;
              await deliverSlashPayloads([payload], (settlement) => {
                visibleReplySent = settlement.visibleReplySent;
              });
              return visibleReplySent
                ? { visibleReplySent: true }
                : {
                    visibleReplySent: false,
                    suppression: { reason: "no_visible_result" as const },
                  };
            }
            const finalization = createDeferred<{ visibleReplySent: boolean }>();
            pendingSlashReplies.push({ payload, finalization });
            return { visibleReplySent: false, finalization: finalization.promise };
          },
          onError: (err, info) => {
            runtime.error?.(
              danger(`slack slash ${info.kind} reply failed: ${formatSlackError(err)}`),
            );
          },
        },
        replyOptions: {
          isCommandTargetCurrent: isCurrentSession,
          skillFilter: channelConfig?.skills,
          ...pluginCommandReplyOptions,
          ...builtInDispatch,
        },
      });
      return true;
    } catch (err) {
      runtime.error?.(danger(`slack slash handler failed: ${formatErrorMessage(err)}`));
      if (!(err instanceof SlackResponseAlreadyReportedError) && responseBudget.remaining() !== 0) {
        await respondEphemeral("Sorry, something went wrong handling that command.");
      }
    }
    return false;
  };
}

export async function registerSlackMonitorSlashCommands(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  trackEvent?: () => void;
}): Promise<SlackCommandRegistration> {
  const { ctx, account, trackEvent } = params;
  const startupCfg = ctx.cfg;
  const runtime = ctx.runtime;
  const resolveEventScope = (
    args: { body: unknown } & Pick<AllMiddlewareArgs, "context" | "client">,
  ) =>
    resolveSlackMonitorEventScope({
      ...args,
      ctx,
      onDrop: (reason) => runtime.log?.(`slack: drop slash payload (${reason})`),
    });
  const supportsInteractiveArgMenus = typeof ctx.app.action === "function";
  let supportsExternalArgMenus = typeof ctx.app.options === "function";

  const slashCommand = resolveSlackSlashCommandConfig(
    ctx.slashCommand ?? account.config.slashCommand,
  );
  // App Home and argument handlers must share the registered command mode;
  // explicit single-command mode also avoids loading inactive native runtimes.
  let registration: SlackCommandRegistration = slashCommand.enabled
    ? { mode: "single", name: slashCommand.name }
    : { mode: "disabled" };

  const handleSlashCommand = createSlackCommandHandler({
    ctx,
    account,
    trackEvent,
    supportsExternalArgMenus: () => supportsExternalArgMenus,
  });
  const registerCommand = (
    matcher: string | RegExp,
    prepareCommand: (
      command: SlackCommandHandlerArgs["command"],
    ) => Pick<
      Parameters<typeof handleSlashCommand>[0],
      "prompt" | "commandArgs" | "commandDefinition" | "pluginCommandReplyOptions"
    > = (command) => ({ prompt: command.text?.trim() ?? "" }),
  ) => {
    ctx.app.command(matcher, async (args: SlackCommandHandlerArgs) => {
      const { command, ack, respond, body } = args;
      const eventScope = resolveEventScope(args);
      if (eventScope === null) {
        await ack({ text: "This Slack workspace is unavailable.", response_type: "ephemeral" });
        return;
      }
      const input = prepareCommand(command);
      await handleSlashCommand({
        command,
        ack,
        respond: createSlackSlashResponderWithFallback({
          respond,
          client: args.client,
          command,
          runtime,
        }),
        body,
        eventScope,
        senderAuthentication: resolveSlackSenderAuthentication(args.context),
        ...input,
      });
    });
  };

  let nativeCommands: SlackNativeCommandSpec[] = [];
  let pluginCommandRuntimeModule:
    | typeof import("openclaw/plugin-sdk/plugin-command-runtime")
    | null = null;
  if (
    registration.mode === "disabled" &&
    resolveNativeCommandsEnabled({
      providerId: "slack",
      providerSetting: account.config.commands?.native,
      globalSetting: startupCfg.commands?.native,
    })
  ) {
    const skillCommands = resolveNativeSkillsEnabled({
      providerId: "slack",
      providerSetting: account.config.commands?.nativeSkills,
      globalSetting: startupCfg.commands?.nativeSkills,
    })
      ? await prepareSkillCommandsForAgents({ cfg: startupCfg })
      : [];
    nativeCommands = listNativeCommandSpecsForConfig(startupCfg, {
      skillCommands,
      provider: "slack",
    });
    pluginCommandRuntimeModule = await loadPluginCommandRuntime();
    const pluginCommandRuntime = pluginCommandRuntimeModule.createPluginCommandRuntime();
    nativeCommands = mergeNativeCommandSpecs({
      primary: nativeCommands,
      secondary: pluginCommandRuntime.listNativeCandidates("slack"),
    });
    registration = nativeCommands.length > 0 ? { mode: "native" } : { mode: "disabled" };
  }

  if (registration.mode === "single") {
    registerCommand(buildSlackSlashCommandMatcher(registration.name));
  } else if (registration.mode === "native") {
    if (!pluginCommandRuntimeModule) {
      throw new Error("Missing command runtimes for native Slack commands.");
    }
    for (const command of nativeCommands) {
      const pluginCommandCandidate = "prepareDispatch" in command ? command : undefined;
      registerCommand(`/${command.name}`, (cmd) => {
        const commandDefinition = pluginCommandCandidate
          ? undefined
          : findCommandByNativeName(command.name, "slack");
        const rawText = cmd.text?.trim() ?? "";
        const pluginCommandDispatch =
          pluginCommandCandidate?.prepareDispatch(rawText) ?? NON_PLUGIN_COMMAND_DISPATCH;
        const commandArgs = commandDefinition
          ? parseCommandArgs(commandDefinition, rawText)
          : rawText
            ? ({ raw: rawText } satisfies CommandArgs)
            : undefined;
        const prompt = commandDefinition
          ? buildCommandTextFromArgs(commandDefinition, commandArgs)
          : rawText
            ? `/${command.name} ${rawText}`
            : `/${command.name}`;
        return {
          prompt,
          commandArgs,
          commandDefinition: commandDefinition ?? undefined,
          pluginCommandReplyOptions: {
            [pluginCommandRuntimeModule.PLUGIN_COMMAND_DISPATCH]: pluginCommandDispatch,
          },
        };
      });
    }
  } else {
    logVerbose("slack: slash commands disabled");
  }

  if (registration.mode !== "native" || !supportsInteractiveArgMenus) {
    return registration;
  }

  const registerArgOptions = () => {
    if (typeof ctx.app.options !== "function") {
      return;
    }
    ctx.app.options(SLACK_COMMAND_ARG_ACTION_ID, async (args: SlackArgOptionsHandlerArgs) => {
      const { ack, body } = args;
      if (resolveEventScope(args) === null) {
        await ack({ options: [] });
        return;
      }
      if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
        await ack({ options: [] });
        runtime.log?.("slack: drop slash arg options payload (mismatched app/team)");
        return;
      }
      trackEvent?.();
      const typedBody = body as {
        value?: string;
        user?: { id?: string };
        actions?: Array<{ block_id?: string }>;
        block_id?: string;
      };
      const blockId = typedBody.actions?.[0]?.block_id ?? typedBody.block_id;
      const token = slackExternalArgMenuStore.readToken(blockId);
      if (!token) {
        await ack({ options: [] });
        return;
      }
      const entry = slackExternalArgMenuStore.get(token);
      if (!entry) {
        await ack({ options: [] });
        return;
      }
      const requesterUserId = typedBody.user?.id?.trim();
      if (!requesterUserId || requesterUserId !== entry.userId) {
        await ack({ options: [] });
        return;
      }
      const query = normalizeLowercaseStringOrEmpty(typedBody.value);
      const options = buildSlackArgMenuOptions(
        entry.choices
          .filter(
            (choice) => !query || normalizeLowercaseStringOrEmpty(choice.label).includes(query),
          )
          .slice(0, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX),
      );
      await ack({ options });
    });
  };
  // Treat external arg-menu registration as best-effort: if Bolt's app.options()
  // throws (e.g. from receiver init issues), disable external selects and fall back
  // to static_select/button menus instead of crashing the entire provider startup.
  try {
    registerArgOptions();
  } catch (err) {
    supportsExternalArgMenus = false;
    runtime.log?.(
      warn(
        "slack: external arg-menu registration failed; falling back to static slash command menus. Enable verbose logs for details.",
      ),
    );
    logVerbose(
      `slack: external arg-menu registration failed, falling back to static menus: ${formatErrorMessage(err)}`,
    );
  }

  ctx.app.action(SLACK_COMMAND_ARG_ACTION_LISTENER, async (args: SlackArgActionHandlerArgs) => {
    const { ack, body, respond } = args;
    const action = args.action as { value?: string; selected_option?: { value?: string } };
    await ack();
    const eventScope = resolveEventScope(args);
    if (eventScope === null) {
      return;
    }
    if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
      runtime.log?.("slack: drop slash arg action payload (mismatched app/team)");
      return;
    }
    const respondFn: SlackCommandMiddlewareArgs["respond"] =
      respond ??
      (async (message) => {
        if (!body.channel?.id || !body.user?.id) {
          return new Response(null, { status: 204 });
        }
        return await deliverSlackSlashResponseWithWebApi({
          client: args.client,
          token: ctx.botToken,
          command: { channel_id: body.channel.id, user_id: body.user.id },
          threadTs: body.container?.thread_ts ?? body.message?.thread_ts,
          message: {
            ...(typeof message === "string" ? { text: message } : message),
            response_type: "ephemeral",
          },
        });
      });
    const actionValue = action?.value ?? action?.selected_option?.value;
    const parsed = parseSlackCommandArgValue(actionValue);
    if (!parsed) {
      await respondFn({
        text: "Sorry, that button is no longer valid.",
        response_type: "ephemeral",
      });
      return;
    }
    if (body.user?.id && parsed.userId !== body.user.id) {
      await respondFn({
        text: "That menu is for another user.",
        response_type: "ephemeral",
      });
      return;
    }
    const commandDefinition = findCommandByNativeName(parsed.command, "slack");
    const commandArgs: CommandArgs = {
      values: { [parsed.arg]: parsed.value },
    };
    const prompt = commandDefinition
      ? buildCommandTextFromArgs(commandDefinition, commandArgs)
      : `/${parsed.command} ${parsed.value}`;
    const user = body.user;
    const userName =
      user && "name" in user && user.name
        ? user.name
        : user && "username" in user && user.username
          ? user.username
          : (user?.id ?? "");
    const triggerId = "trigger_id" in body ? body.trigger_id : undefined;
    const commandPayload = {
      user_id: user?.id ?? "",
      user_name: userName,
      channel_id: body.channel?.id ?? "",
      channel_name: body.channel?.name ?? body.channel?.id ?? "",
      trigger_id: triggerId,
    };
    await handleSlashCommand({
      command: commandPayload,
      ack: async () => {},
      respond: respondFn,
      // Bolt's action responder uses response_url; only the postEphemeral fallback
      // goes through the uncapped Web API path.
      responseTransport: respond ? "response-url" : "web-api",
      body,
      eventScope,
      senderAuthentication: resolveSlackSenderAuthentication(args.context),
      prompt,
      commandArgs,
      commandDefinition: commandDefinition ?? undefined,
      pluginCommandReplyOptions: pluginCommandRuntimeModule
        ? { [pluginCommandRuntimeModule.PLUGIN_COMMAND_DISPATCH]: NON_PLUGIN_COMMAND_DISPATCH }
        : undefined,
    });
  });
  return registration;
}

function createSlackSlashResponderWithFallback(params: {
  respond: SlackCommandMiddlewareArgs["respond"];
  client: AllMiddlewareArgs["client"];
  command: SlackCommandMiddlewareArgs["command"];
  runtime: SlackMonitorContext["runtime"];
}): SlackCommandMiddlewareArgs["respond"] {
  return async (message) => {
    try {
      return await params.respond(message);
    } catch (error) {
      if (!isSlackBoltRespondError(error)) {
        throw error;
      }
      params.runtime.log?.(
        warn(
          `slack slash response_url failed; falling back to Web API: ${formatErrorMessage(error)}`,
        ),
      );
      return await deliverSlackSlashResponseWithWebApi({
        client: params.client,
        command: params.command,
        message,
      });
    }
  };
}

export async function deliverSlackSlashResponseWithWebApi(params: {
  client: AllMiddlewareArgs["client"];
  token?: string;
  command: Pick<SlackCommandMiddlewareArgs["command"], "channel_id" | "user_id">;
  threadTs?: string;
  message: Parameters<SlackCommandMiddlewareArgs["respond"]>[0];
}): Promise<Response> {
  const payload = typeof params.message === "string" ? { text: params.message } : params.message;
  const text = payload.text ?? "";
  const blocks = "blocks" in payload && Array.isArray(payload.blocks) ? payload.blocks : undefined;
  const mrkdwn =
    "mrkdwn" in payload && typeof payload.mrkdwn === "boolean" ? payload.mrkdwn : undefined;

  const message = {
    ...(params.token !== undefined ? { token: params.token } : {}),
    channel: params.command.channel_id,
    ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    text,
    ...(blocks ? { blocks } : {}),
    ...(mrkdwn !== undefined ? { mrkdwn } : {}),
  };
  if (payload.response_type === "in_channel") {
    const postSlackMessage = params.client.chat.postMessage.bind(params.client.chat);
    const response = await postSlackMessage(message);
    requireSlackPostMessageTimestamp(response);
  } else {
    await params.client.chat.postEphemeral({ ...message, user: params.command.user_id });
  }
  return new Response(null, { status: 200 });
}

function isSlackBoltRespondError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "slack_bolt_respond_error"
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
