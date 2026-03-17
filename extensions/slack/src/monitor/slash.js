import { resolveCommandAuthorizedFromAuthorizers } from "../../../../src/channels/command-gating.js";
import { resolveNativeCommandSessionTargets } from "../../../../src/channels/native-command-session-targets.js";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled
} from "../../../../src/config/commands.js";
import { danger, logVerbose } from "../../../../src/globals.js";
import { chunkItems } from "../../../../src/utils/chunk-items.js";
import { truncateSlackText } from "../truncate.js";
import { resolveSlackAllowListMatch, resolveSlackUserAllowed } from "./allow-list.js";
import { resolveSlackEffectiveAllowFrom } from "./auth.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { buildSlackSlashCommandMatcher, resolveSlackSlashCommandConfig } from "./commands.js";
import { normalizeSlackChannelType } from "./context.js";
import { authorizeSlackDirectMessage } from "./dm-auth.js";
import {
  createSlackExternalArgMenuStore,
  SLACK_EXTERNAL_ARG_MENU_PREFIX
} from "./external-arg-menu-store.js";
import { escapeSlackMrkdwn } from "./mrkdwn.js";
import { isSlackChannelAllowedByPolicy } from "./policy.js";
import { resolveSlackRoomContextHints } from "./room-context.js";
const SLACK_COMMAND_ARG_ACTION_ID = "openclaw_cmdarg";
const SLACK_COMMAND_ARG_VALUE_PREFIX = "cmdarg";
const SLACK_COMMAND_ARG_BUTTON_ROW_SIZE = 5;
const SLACK_COMMAND_ARG_OVERFLOW_MIN = 3;
const SLACK_COMMAND_ARG_OVERFLOW_MAX = 5;
const SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX = 100;
const SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX = 75;
const SLACK_HEADER_TEXT_MAX = 150;
let slashCommandsRuntimePromise = null;
let slashDispatchRuntimePromise = null;
let slashSkillCommandsRuntimePromise = null;
function loadSlashCommandsRuntime() {
  slashCommandsRuntimePromise ??= import("./slash-commands.runtime.js");
  return slashCommandsRuntimePromise;
}
function loadSlashDispatchRuntime() {
  slashDispatchRuntimePromise ??= import("./slash-dispatch.runtime.js");
  return slashDispatchRuntimePromise;
}
function loadSlashSkillCommandsRuntime() {
  slashSkillCommandsRuntimePromise ??= import("./slash-skill-commands.runtime.js");
  return slashSkillCommandsRuntimePromise;
}
const slackExternalArgMenuStore = createSlackExternalArgMenuStore();
function buildSlackArgMenuConfirm(params) {
  const command = escapeSlackMrkdwn(params.command);
  const arg = escapeSlackMrkdwn(params.arg);
  return {
    title: { type: "plain_text", text: "Confirm selection" },
    text: {
      type: "mrkdwn",
      text: `Run */${command}* with *${arg}* set to this value?`
    },
    confirm: { type: "plain_text", text: "Run command" },
    deny: { type: "plain_text", text: "Cancel" }
  };
}
function storeSlackExternalArgMenu(params) {
  return slackExternalArgMenuStore.create({
    choices: params.choices,
    userId: params.userId
  });
}
function readSlackExternalArgMenuToken(raw) {
  return slackExternalArgMenuStore.readToken(raw);
}
function encodeSlackCommandArgValue(parts) {
  return [
    SLACK_COMMAND_ARG_VALUE_PREFIX,
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId)
  ].join("|");
}
function parseSlackCommandArgValue(raw) {
  if (!raw) {
    return null;
  }
  const parts = raw.split("|");
  if (parts.length !== 5 || parts[0] !== SLACK_COMMAND_ARG_VALUE_PREFIX) {
    return null;
  }
  const [, command, arg, value, userId] = parts;
  if (!command || !arg || !value || !userId) {
    return null;
  }
  const decode = (text) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return null;
    }
  };
  const decodedCommand = decode(command);
  const decodedArg = decode(arg);
  const decodedValue = decode(value);
  const decodedUserId = decode(userId);
  if (!decodedCommand || !decodedArg || !decodedValue || !decodedUserId) {
    return null;
  }
  return {
    command: decodedCommand,
    arg: decodedArg,
    value: decodedValue,
    userId: decodedUserId
  };
}
function buildSlackArgMenuOptions(choices) {
  return choices.map((choice) => ({
    text: { type: "plain_text", text: choice.label.slice(0, 75) },
    value: choice.value
  }));
}
function buildSlackCommandArgMenuBlocks(params) {
  const encodedChoices = params.choices.map((choice) => ({
    label: choice.label,
    value: encodeSlackCommandArgValue({
      command: params.command,
      arg: params.arg,
      value: choice.value,
      userId: params.userId
    })
  }));
  const canUseStaticSelect = encodedChoices.every(
    (choice) => choice.value.length <= SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX
  );
  const canUseOverflow = canUseStaticSelect && encodedChoices.length >= SLACK_COMMAND_ARG_OVERFLOW_MIN && encodedChoices.length <= SLACK_COMMAND_ARG_OVERFLOW_MAX;
  const canUseExternalSelect = params.supportsExternalSelect && canUseStaticSelect && encodedChoices.length > SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX;
  const rows = canUseOverflow ? [
    {
      type: "actions",
      elements: [
        {
          type: "overflow",
          action_id: SLACK_COMMAND_ARG_ACTION_ID,
          confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
          options: buildSlackArgMenuOptions(encodedChoices)
        }
      ]
    }
  ] : canUseExternalSelect ? [
    {
      type: "actions",
      block_id: `${SLACK_EXTERNAL_ARG_MENU_PREFIX}${params.createExternalMenuToken(
        encodedChoices
      )}`,
      elements: [
        {
          type: "external_select",
          action_id: SLACK_COMMAND_ARG_ACTION_ID,
          confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
          min_query_length: 0,
          placeholder: {
            type: "plain_text",
            text: `Search ${params.arg}`
          }
        }
      ]
    }
  ] : encodedChoices.length <= SLACK_COMMAND_ARG_BUTTON_ROW_SIZE || !canUseStaticSelect ? chunkItems(encodedChoices, SLACK_COMMAND_ARG_BUTTON_ROW_SIZE).map((choices) => ({
    type: "actions",
    elements: choices.map((choice) => ({
      type: "button",
      action_id: SLACK_COMMAND_ARG_ACTION_ID,
      text: { type: "plain_text", text: choice.label },
      value: choice.value,
      confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg })
    }))
  })) : chunkItems(encodedChoices, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map(
    (choices, index) => ({
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: SLACK_COMMAND_ARG_ACTION_ID,
          confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
          placeholder: {
            type: "plain_text",
            text: index === 0 ? `Choose ${params.arg}` : `Choose ${params.arg} (${index + 1})`
          },
          options: buildSlackArgMenuOptions(choices)
        }
      ]
    })
  );
  const headerText = truncateSlackText(
    `/${params.command}: choose ${params.arg}`,
    SLACK_HEADER_TEXT_MAX
  );
  const sectionText = truncateSlackText(params.title, 3e3);
  const contextText = truncateSlackText(
    `Select one option to continue /${params.command} (${params.arg})`,
    3e3
  );
  return [
    {
      type: "header",
      text: { type: "plain_text", text: headerText }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: sectionText }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextText }]
    },
    ...rows
  ];
}
async function registerSlackMonitorSlashCommands(params) {
  const { ctx, account } = params;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;
  const supportsInteractiveArgMenus = typeof ctx.app.action === "function";
  let supportsExternalArgMenus = typeof ctx.app.options === "function";
  const slashCommand = resolveSlackSlashCommandConfig(
    ctx.slashCommand ?? account.config.slashCommand
  );
  const handleSlashCommand = async (p) => {
    const { command, ack, respond, body, prompt, commandArgs, commandDefinition } = p;
    try {
      if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
        await ack();
        runtime.log?.(
          `slack: drop slash command from user=${command.user_id ?? "unknown"} channel=${command.channel_id ?? "unknown"} (mismatched app/team)`
        );
        return;
      }
      if (!prompt.trim()) {
        await ack({
          text: "Message required.",
          response_type: "ephemeral"
        });
        return;
      }
      await ack();
      if (ctx.botUserId && command.user_id === ctx.botUserId) {
        return;
      }
      const channelInfo = await ctx.resolveChannelName(command.channel_id);
      const rawChannelType = channelInfo?.type ?? (command.channel_name === "directmessage" ? "im" : void 0);
      const channelType = normalizeSlackChannelType(rawChannelType, command.channel_id);
      const isDirectMessage = channelType === "im";
      const isGroupDm = channelType === "mpim";
      const isRoom = channelType === "channel" || channelType === "group";
      const isRoomish = isRoom || isGroupDm;
      if (!ctx.isChannelAllowed({
        channelId: command.channel_id,
        channelName: channelInfo?.name,
        channelType
      })) {
        await respond({
          text: "This channel is not allowed.",
          response_type: "ephemeral"
        });
        return;
      }
      const { allowFromLower: effectiveAllowFromLower } = await resolveSlackEffectiveAllowFrom(
        ctx,
        {
          includePairingStore: isDirectMessage
        }
      );
      let commandAuthorized = false;
      let channelConfig = null;
      if (isDirectMessage) {
        const allowed = await authorizeSlackDirectMessage({
          ctx,
          accountId: ctx.accountId,
          senderId: command.user_id,
          allowFromLower: effectiveAllowFromLower,
          resolveSenderName: ctx.resolveUserName,
          sendPairingReply: async (text) => {
            await respond({
              text,
              response_type: "ephemeral"
            });
          },
          onDisabled: async () => {
            await respond({
              text: "Slack DMs are disabled.",
              response_type: "ephemeral"
            });
          },
          onUnauthorized: async ({ allowMatchMeta }) => {
            logVerbose(
              `slack: blocked slash sender ${command.user_id} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`
            );
            await respond({
              text: "You are not authorized to use this command.",
              response_type: "ephemeral"
            });
          },
          log: logVerbose
        });
        if (!allowed) {
          return;
        }
      }
      if (isRoom) {
        channelConfig = resolveSlackChannelConfig({
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channels: ctx.channelsConfig,
          channelKeys: ctx.channelsConfigKeys,
          defaultRequireMention: ctx.defaultRequireMention,
          allowNameMatching: ctx.allowNameMatching
        });
        if (ctx.useAccessGroups) {
          const channelAllowlistConfigured = (ctx.channelsConfigKeys?.length ?? 0) > 0;
          const channelAllowed = channelConfig?.allowed !== false;
          if (!isSlackChannelAllowedByPolicy({
            groupPolicy: ctx.groupPolicy,
            channelAllowlistConfigured,
            channelAllowed
          })) {
            await respond({
              text: "This channel is not allowed.",
              response_type: "ephemeral"
            });
            return;
          }
          const hasExplicitConfig = Boolean(channelConfig?.matchSource);
          if (!channelAllowed && (ctx.groupPolicy !== "open" || hasExplicitConfig)) {
            await respond({
              text: "This channel is not allowed.",
              response_type: "ephemeral"
            });
            return;
          }
        }
      }
      const sender = await ctx.resolveUserName(command.user_id);
      const senderName = sender?.name ?? command.user_name ?? command.user_id;
      const channelUsersAllowlistConfigured = isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
      const channelUserAllowed = channelUsersAllowlistConfigured ? resolveSlackUserAllowed({
        allowList: channelConfig?.users,
        userId: command.user_id,
        userName: senderName,
        allowNameMatching: ctx.allowNameMatching
      }) : false;
      if (channelUsersAllowlistConfigured && !channelUserAllowed) {
        await respond({
          text: "You are not authorized to use this command here.",
          response_type: "ephemeral"
        });
        return;
      }
      const ownerAllowed = resolveSlackAllowListMatch({
        allowList: effectiveAllowFromLower,
        id: command.user_id,
        name: senderName,
        allowNameMatching: ctx.allowNameMatching
      }).allowed;
      commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: ctx.useAccessGroups,
        authorizers: [{ configured: effectiveAllowFromLower.length > 0, allowed: ownerAllowed }],
        modeWhenAccessGroupsOff: "configured"
      });
      if (isRoomish) {
        commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups: ctx.useAccessGroups,
          authorizers: [
            { configured: effectiveAllowFromLower.length > 0, allowed: ownerAllowed },
            { configured: channelUsersAllowlistConfigured, allowed: channelUserAllowed }
          ],
          modeWhenAccessGroupsOff: "configured"
        });
        if (ctx.useAccessGroups && !commandAuthorized) {
          await respond({
            text: "You are not authorized to use this command.",
            response_type: "ephemeral"
          });
          return;
        }
      }
      if (commandDefinition && supportsInteractiveArgMenus) {
        const { resolveCommandArgMenu } = await loadSlashCommandsRuntime();
        const menu = resolveCommandArgMenu({
          command: commandDefinition,
          args: commandArgs,
          cfg
        });
        if (menu) {
          const commandLabel = commandDefinition.nativeName ?? commandDefinition.key;
          const title = menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
          const blocks = buildSlackCommandArgMenuBlocks({
            title,
            command: commandLabel,
            arg: menu.arg.name,
            choices: menu.choices,
            userId: command.user_id,
            supportsExternalSelect: supportsExternalArgMenus,
            createExternalMenuToken: (choices) => storeSlackExternalArgMenu({ choices, userId: command.user_id })
          });
          await respond({
            text: title,
            blocks,
            response_type: "ephemeral"
          });
          return;
        }
      }
      const channelName = channelInfo?.name;
      const roomLabel = channelName ? `#${channelName}` : `#${command.channel_id}`;
      const {
        createReplyPrefixOptions,
        deliverSlackSlashReplies,
        dispatchReplyWithDispatcher,
        finalizeInboundContext,
        recordInboundSessionMetaSafe,
        resolveAgentRoute,
        resolveChunkMode,
        resolveConversationLabel,
        resolveMarkdownTableMode
      } = await loadSlashDispatchRuntime();
      const route = resolveAgentRoute({
        cfg,
        channel: "slack",
        accountId: account.accountId,
        teamId: ctx.teamId || void 0,
        peer: {
          kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
          id: isDirectMessage ? command.user_id : command.channel_id
        }
      });
      const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
        isRoomish,
        channelInfo,
        channelConfig
      });
      const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
        agentId: route.agentId,
        sessionPrefix: slashCommand.sessionPrefix,
        userId: command.user_id,
        targetSessionKey: route.sessionKey,
        lowercaseSessionKey: true
      });
      const ctxPayload = finalizeInboundContext({
        Body: prompt,
        BodyForAgent: prompt,
        RawBody: prompt,
        CommandBody: prompt,
        CommandArgs: commandArgs,
        From: isDirectMessage ? `slack:${command.user_id}` : isRoom ? `slack:channel:${command.channel_id}` : `slack:group:${command.channel_id}`,
        To: `slash:${command.user_id}`,
        ChatType: isDirectMessage ? "direct" : "channel",
        ConversationLabel: resolveConversationLabel({
          ChatType: isDirectMessage ? "direct" : "channel",
          SenderName: senderName,
          GroupSubject: isRoomish ? roomLabel : void 0,
          From: isDirectMessage ? `slack:${command.user_id}` : isRoom ? `slack:channel:${command.channel_id}` : `slack:group:${command.channel_id}`
        }) ?? (isDirectMessage ? senderName : roomLabel),
        GroupSubject: isRoomish ? roomLabel : void 0,
        GroupSystemPrompt: isRoomish ? groupSystemPrompt : void 0,
        UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : void 0,
        SenderName: senderName,
        SenderId: command.user_id,
        Provider: "slack",
        Surface: "slack",
        WasMentioned: true,
        MessageSid: command.trigger_id,
        Timestamp: Date.now(),
        SessionKey: sessionKey,
        CommandTargetSessionKey: commandTargetSessionKey,
        AccountId: route.accountId,
        CommandSource: "native",
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "slack",
        OriginatingTo: `user:${command.user_id}`
      });
      await recordInboundSessionMetaSafe({
        cfg,
        agentId: route.agentId,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onError: (err) => runtime.error?.(danger(`slack slash: failed updating session meta: ${String(err)}`))
      });
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: route.agentId,
        channel: "slack",
        accountId: route.accountId
      });
      const deliverSlashPayloads = async (replies) => {
        await deliverSlackSlashReplies({
          replies,
          respond,
          ephemeral: slashCommand.ephemeral,
          textLimit: ctx.textLimit,
          chunkMode: resolveChunkMode(cfg, "slack", route.accountId),
          tableMode: resolveMarkdownTableMode({
            cfg,
            channel: "slack",
            accountId: route.accountId
          })
        });
      };
      const { counts } = await dispatchReplyWithDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          ...prefixOptions,
          deliver: async (payload) => deliverSlashPayloads([payload]),
          onError: (err, info) => {
            runtime.error?.(danger(`slack slash ${info.kind} reply failed: ${String(err)}`));
          }
        },
        replyOptions: {
          skillFilter: channelConfig?.skills,
          onModelSelected
        }
      });
      if (counts.final + counts.tool + counts.block === 0) {
        await deliverSlashPayloads([]);
      }
    } catch (err) {
      runtime.error?.(danger(`slack slash handler failed: ${String(err)}`));
      await respond({
        text: "Sorry, something went wrong handling that command.",
        response_type: "ephemeral"
      });
    }
  };
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "slack",
    providerSetting: account.config.commands?.native,
    globalSetting: cfg.commands?.native
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "slack",
    providerSetting: account.config.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills
  });
  let nativeCommands = [];
  let slashCommandsRuntime = null;
  if (nativeEnabled) {
    slashCommandsRuntime = await loadSlashCommandsRuntime();
    const skillCommands = nativeSkillsEnabled ? (await loadSlashSkillCommandsRuntime()).listSkillCommandsForAgents({ cfg }) : [];
    nativeCommands = slashCommandsRuntime.listNativeCommandSpecsForConfig(cfg, {
      skillCommands,
      provider: "slack"
    });
  }
  if (nativeCommands.length > 0) {
    if (!slashCommandsRuntime) {
      throw new Error("Missing commands runtime for native Slack commands.");
    }
    for (const command of nativeCommands) {
      ctx.app.command(
        `/${command.name}`,
        async ({ command: cmd, ack, respond, body }) => {
          const commandDefinition = slashCommandsRuntime.findCommandByNativeName(
            command.name,
            "slack"
          );
          const rawText = cmd.text?.trim() ?? "";
          const commandArgs = commandDefinition ? slashCommandsRuntime.parseCommandArgs(commandDefinition, rawText) : rawText ? { raw: rawText } : void 0;
          const prompt = commandDefinition ? slashCommandsRuntime.buildCommandTextFromArgs(commandDefinition, commandArgs) : rawText ? `/${command.name} ${rawText}` : `/${command.name}`;
          await handleSlashCommand({
            command: cmd,
            ack,
            respond,
            body,
            prompt,
            commandArgs,
            commandDefinition: commandDefinition ?? void 0
          });
        }
      );
    }
  } else if (slashCommand.enabled) {
    ctx.app.command(
      buildSlackSlashCommandMatcher(slashCommand.name),
      async ({ command, ack, respond, body }) => {
        await handleSlashCommand({
          command,
          ack,
          respond,
          body,
          prompt: command.text?.trim() ?? ""
        });
      }
    );
  } else {
    logVerbose("slack: slash commands disabled");
  }
  if (nativeCommands.length === 0 || !supportsInteractiveArgMenus) {
    return;
  }
  const registerArgOptions = () => {
    const appWithOptions = ctx.app;
    if (typeof appWithOptions.options !== "function") {
      return;
    }
    appWithOptions.options(SLACK_COMMAND_ARG_ACTION_ID, async ({ ack, body }) => {
      if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
        await ack({ options: [] });
        runtime.log?.("slack: drop slash arg options payload (mismatched app/team)");
        return;
      }
      const typedBody = body;
      const blockId = typedBody.actions?.[0]?.block_id ?? typedBody.block_id;
      const token = readSlackExternalArgMenuToken(blockId);
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
      const query = typedBody.value?.trim().toLowerCase() ?? "";
      const options = entry.choices.filter((choice) => !query || choice.label.toLowerCase().includes(query)).slice(0, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map((choice) => ({
        text: { type: "plain_text", text: choice.label.slice(0, 75) },
        value: choice.value
      }));
      await ack({ options });
    });
  };
  try {
    registerArgOptions();
  } catch (err) {
    supportsExternalArgMenus = false;
    logVerbose(
      `slack: external arg-menu registration failed, falling back to static menus: ${String(err)}`
    );
  }
  const registerArgAction = (actionId) => {
    ctx.app.action(actionId, async (args) => {
      const { ack, body, respond } = args;
      const action = args.action;
      await ack();
      if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
        runtime.log?.("slack: drop slash arg action payload (mismatched app/team)");
        return;
      }
      const respondFn = respond ?? (async (payload) => {
        if (!body.channel?.id || !body.user?.id) {
          return;
        }
        await ctx.app.client.chat.postEphemeral({
          token: ctx.botToken,
          channel: body.channel.id,
          user: body.user.id,
          text: payload.text,
          blocks: payload.blocks
        });
      });
      const actionValue = action?.value ?? action?.selected_option?.value;
      const parsed = parseSlackCommandArgValue(actionValue);
      if (!parsed) {
        await respondFn({
          text: "Sorry, that button is no longer valid.",
          response_type: "ephemeral"
        });
        return;
      }
      if (body.user?.id && parsed.userId !== body.user.id) {
        await respondFn({
          text: "That menu is for another user.",
          response_type: "ephemeral"
        });
        return;
      }
      const { buildCommandTextFromArgs, findCommandByNativeName } = await loadSlashCommandsRuntime();
      const commandDefinition = findCommandByNativeName(parsed.command, "slack");
      const commandArgs = {
        values: { [parsed.arg]: parsed.value }
      };
      const prompt = commandDefinition ? buildCommandTextFromArgs(commandDefinition, commandArgs) : `/${parsed.command} ${parsed.value}`;
      const user = body.user;
      const userName = user && "name" in user && user.name ? user.name : user && "username" in user && user.username ? user.username : user?.id ?? "";
      const triggerId = "trigger_id" in body ? body.trigger_id : void 0;
      const commandPayload = {
        user_id: user?.id ?? "",
        user_name: userName,
        channel_id: body.channel?.id ?? "",
        channel_name: body.channel?.name ?? body.channel?.id ?? "",
        trigger_id: triggerId
      };
      await handleSlashCommand({
        command: commandPayload,
        ack: async () => {
        },
        respond: respondFn,
        body,
        prompt,
        commandArgs,
        commandDefinition: commandDefinition ?? void 0
      });
    });
  };
  registerArgAction(SLACK_COMMAND_ARG_ACTION_ID);
}
export {
  registerSlackMonitorSlashCommands
};
