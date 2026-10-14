import type { AllMiddlewareArgs, SlackActionMiddlewareArgs } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { resolveCommandAuthorizationAsync } from "openclaw/plugin-sdk/command-auth-native";
import {
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  decodeSlackApprovalAction,
  SLACK_APPROVAL_HEADER_BLOCK_ID,
  type SlackApprovalAction,
} from "../../approval-actions.js";
import {
  hasSlackApprovalControl,
  runSlackApprovalMessageUpdate,
} from "../../approval-message-updates.js";
import { isSlackExecApprovalAuthorizedSender } from "../../exec-approvals.js";
import {
  dispatchSlackPluginInteractiveHandler,
  type SlackInteractiveHandlerContext,
} from "../../interactive-dispatch.js";
import { decodeSlackQuestionAction, resolveSlackQuestionAction } from "../../question-actions.js";
import {
  isSlackApprovalActionId,
  isSlackCallbackActionId,
  isSlackQuestionActionId,
  SLACK_REPLY_BUTTON_ACTION_ID,
  SLACK_REPLY_LINK_ACTION_ID,
  SLACK_REPLY_SELECT_ACTION_ID,
  SLACK_SESSION_LINK_ACTION_ID,
} from "../../reply-action-ids.js";
import { truncateSlackText } from "../../truncate.js";
import {
  authorizeSlackSystemEventSender,
  resolveSlackCommandIngress,
  resolveSlackEffectiveAllowFrom,
} from "../auth.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackDeferredActionTarget } from "../deferred-action-routing.js";
import { resolveSlackMonitorEventScope, type SlackEventScope } from "../event-scope.js";
import { escapeSlackMrkdwn } from "../mrkdwn.js";
import { enqueueSlackInteractionEvent } from "./interaction-event.js";
import { resolveSlackPluginApprovalSender } from "./interactions.approval-sender.js";
import {
  formatInteractionSelectionLabel,
  summarizeAction,
  type SlackActionSummary,
} from "./modal-input-summary.js";

type InteractionMessageBlock = {
  type?: string;
  block_id?: string;
  elements?: Array<{ action_id?: string }>;
};

type SlackBlockActionBody = {
  user?: { id?: string };
  team?: { id?: string };
  trigger_id?: string;
  response_url?: string;
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string; text?: string; blocks?: unknown[] };
};

type SlackBlockActionRespond = NonNullable<SlackActionMiddlewareArgs["respond"]>;
type SlackBlockActionHandlerArgs = SlackActionMiddlewareArgs &
  Pick<AllMiddlewareArgs, "context" | "client">;

type ParsedSlackBlockAction = {
  typedBody: SlackBlockActionBody;
  typedAction: Record<string, unknown>;
  typedActionWithText: {
    action_id?: string;
    action_ts?: string;
    block_id?: string;
    type?: string;
    text?: { text?: string };
  };
  actionId: string;
  blockId?: string;
  userId: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  actionSummary: SlackActionSummary;
};

type SlackBlockActionContext = {
  ctx: SlackMonitorContext;
  eventScope?: SlackEventScope;
  parsed: ParsedSlackBlockAction;
  respond?: SlackBlockActionRespond;
};

function resolveSlackActionValue(summary: SlackActionSummary): string | undefined {
  return normalizeOptionalString(summary.value) ?? summary.selectedValues?.[0];
}

function buildSlackPluginInteractionData(params: {
  actionId: string;
  summary: SlackActionSummary;
}): string | null {
  const actionId = normalizeOptionalString(params.actionId) ?? "";
  if (!actionId) {
    return null;
  }
  const payload = resolveSlackActionValue(params.summary) ?? "";
  if (isSlackReplyActionId(actionId) || isSlackCallbackActionId(actionId)) {
    return payload || null;
  }
  return payload ? `${actionId}:${payload}` : actionId;
}

function isSlackReplyActionId(actionId: string): boolean {
  return (
    actionId === SLACK_REPLY_BUTTON_ACTION_ID ||
    actionId === SLACK_REPLY_SELECT_ACTION_ID ||
    actionId.startsWith(`${SLACK_REPLY_BUTTON_ACTION_ID}:`) ||
    actionId.startsWith(`${SLACK_REPLY_SELECT_ACTION_ID}:`)
  );
}

function isSlackReplyLinkAction(parsed: ParsedSlackBlockAction): boolean {
  if (parsed.actionId.replace(/:\d+$/u, "") === SLACK_SESSION_LINK_ACTION_ID) {
    return true;
  }
  if (
    parsed.actionId === SLACK_REPLY_LINK_ACTION_ID ||
    parsed.actionId.startsWith(`${SLACK_REPLY_LINK_ACTION_ID}:`)
  ) {
    return true;
  }
  const legacyUrl = normalizeOptionalString((parsed.typedAction as { url?: unknown }).url);
  return Boolean(legacyUrl && isSlackReplyActionId(parsed.actionId));
}

function buildSlackPluginInteractionId(parsed: ParsedSlackBlockAction): string {
  return [
    normalizeOptionalString(parsed.userId) ?? "",
    normalizeOptionalString(parsed.channelId) ?? "",
    normalizeOptionalString(parsed.messageTs) ?? "",
    normalizeOptionalString(parsed.typedBody.trigger_id) ?? "",
    normalizeOptionalString(parsed.actionId) ?? "",
    resolveSlackActionValue(parsed.actionSummary) ?? "",
  ].join(":");
}

function parseSlackBlockAction(params: {
  body: unknown;
  action: unknown;
  log?: (message: string) => void;
}): ParsedSlackBlockAction | null {
  const typedBody = params.body as SlackBlockActionBody;
  const typedAction = asOptionalRecord(params.action);
  if (!typedAction) {
    params.log?.(
      `slack:interaction malformed action payload channel=${typedBody.channel?.id ?? typedBody.container?.channel_id ?? "unknown"} user=${
        typedBody.user?.id ?? "unknown"
      }`,
    );
    return null;
  }
  const typedActionWithText = typedAction as ParsedSlackBlockAction["typedActionWithText"];
  return {
    typedBody,
    typedAction,
    typedActionWithText,
    actionId:
      typeof typedActionWithText.action_id === "string" ? typedActionWithText.action_id : "unknown",
    blockId: typedActionWithText.block_id,
    userId: typedBody.user?.id ?? "unknown",
    channelId: typedBody.channel?.id ?? typedBody.container?.channel_id,
    messageTs: typedBody.message?.ts ?? typedBody.container?.message_ts,
    threadTs: typedBody.container?.thread_ts ?? typedBody.message?.thread_ts,
    actionSummary: summarizeAction(typedAction),
  };
}

async function respondEphemeral(
  respond: SlackBlockActionRespond | undefined,
  text: string,
): Promise<void> {
  if (!respond) {
    return;
  }
  try {
    await respond({
      text,
      response_type: "ephemeral",
    });
  } catch {
    // Best-effort feedback only.
  }
}

async function updateSlackInteractionMessage(
  params: SlackBlockActionContext,
  message: { text: string; blocks?: (Block | KnownBlock)[] },
): Promise<void> {
  const { channelId, messageTs } = params.parsed;
  if (!channelId || !messageTs) {
    return;
  }
  await (params.eventScope?.client ?? params.ctx.app.client).chat.update({
    channel: channelId,
    ts: messageTs,
    text: message.text,
    ...(message.blocks ? { blocks: message.blocks } : {}),
  });
}

function resolveSlackApprovalTerminalLabel(approval: ApprovalResolveResult["approval"]): string {
  if (approval.status === "allowed") {
    return approval.decision === "allow-always" ? "Allowed always" : "Allowed once";
  }
  if (approval.status === "denied") {
    return "Denied";
  }
  if (approval.status === "expired") {
    return "Expired";
  }
  return "Cancelled";
}

function removeSlackApprovalControls(blocks: unknown[]): (Block | KnownBlock)[] {
  return blocks.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return [block as Block | KnownBlock];
    }
    const typedBlock = block as InteractionMessageBlock;
    if (typedBlock.type !== "actions" || !Array.isArray(typedBlock.elements)) {
      return [block as Block | KnownBlock];
    }
    const elements = typedBlock.elements.filter(
      (element) =>
        typeof element.action_id !== "string" || !isSlackApprovalActionId(element.action_id),
    );
    return elements.length > 0 ? [{ ...block, elements } as Block | KnownBlock] : [];
  });
}

function buildSlackApprovalTerminalBlocks(params: {
  blocks: unknown[] | undefined;
  label: string;
  prefix: "Resolved" | "Already resolved";
}): (Block | KnownBlock)[] {
  const blocks = removeSlackApprovalControls(params.blocks ?? []).filter((block) => {
    const blockId = (block as { block_id?: unknown }).block_id;
    return !(
      (block as { type?: unknown }).type === "section" && blockId === SLACK_APPROVAL_HEADER_BLOCK_ID
    );
  });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${params.prefix}: ${params.label}*` },
    },
    ...blocks,
  ];
}

async function authorizeSlackBlockAction(params: SlackBlockActionContext): Promise<
  | {
      allowed: true;
      channelType?: "im" | "mpim" | "channel" | "group";
    }
  | { allowed: false }
> {
  const auth = await authorizeSlackSystemEventSender({
    ctx: params.ctx,
    eventScope: params.eventScope,
    senderId: params.parsed.userId,
    channelId: params.parsed.channelId,
    channelType: params.parsed.channelId ? undefined : "im",
    // Block action sender identity is verified by Slack's request signing.
    // Pass the Slack-verified userId as expectedSenderId to satisfy the
    // mandatory actor-binding requirement for interactive events.
    expectedSenderId: params.parsed.userId,
    interactiveEvent: true,
  });
  if (auth.allowed) {
    return auth;
  }
  params.ctx.runtime.log?.(
    `slack:interaction drop action=${params.parsed.actionId} user=${params.parsed.userId} channel=${params.parsed.channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`,
  );
  await respondEphemeral(params.respond, "You are not authorized to use this control.");
  return { allowed: false };
}

async function handleSlackPluginBindingApproval(
  params: SlackBlockActionContext & { pluginInteractionData: string },
): Promise<boolean> {
  const pluginBindingApproval = parsePluginBindingApprovalCustomId(params.pluginInteractionData);
  if (!pluginBindingApproval) {
    return false;
  }
  const resolved = await resolvePluginConversationBindingApproval({
    approvalId: pluginBindingApproval.approvalId,
    decision: pluginBindingApproval.decision,
    senderId: params.parsed.userId,
  });
  try {
    await updateSlackInteractionMessage(params, {
      text: params.parsed.typedBody.message?.text ?? "",
      blocks: [],
    });
  } catch {
    // Best-effort cleanup only; continue with follow-up feedback.
  }
  await respondEphemeral(params.respond, buildPluginBindingResolvedText(resolved));
  return true;
}

async function handleSlackApprovalInteraction(
  params: SlackBlockActionContext & { approval: SlackApprovalAction },
): Promise<boolean> {
  const pluginSender = resolveSlackPluginApprovalSender({
    ctx: params.ctx,
    eventScope: params.eventScope,
    userId: params.parsed.userId,
  });
  const execApprovalAuthorizedSender = isSlackExecApprovalAuthorizedSender({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId,
    senderId: params.parsed.userId,
  });
  const authorized =
    params.approval.approvalKind === "plugin"
      ? pluginSender.authorized
      : execApprovalAuthorizedSender;
  if (!authorized) {
    params.ctx.runtime.log?.(
      `slack:interaction drop ${params.approval.approvalKind} approval user=${params.parsed.userId} (not authorized)`,
    );
    await respondEphemeral(params.respond, "You are not authorized to approve this request.");
    return true;
  }

  try {
    const result = await resolveApprovalOverGateway({
      cfg: params.ctx.cfg,
      approvalId: params.approval.approvalId,
      approvalKind: params.approval.approvalKind,
      decision: params.approval.decision,
      channel: "slack",
      accountId: params.ctx.accountId,
      senderId:
        params.approval.approvalKind === "plugin" ? pluginSender.senderId : params.parsed.userId,
    });
    const terminalLabel = resolveSlackApprovalTerminalLabel(result.approval);
    const prefix = result.applied ? "Resolved" : "Already resolved";
    const { channelId, messageTs } = params.parsed;
    let terminalized = false;
    if (channelId && messageTs) {
      try {
        terminalized = await runSlackApprovalMessageUpdate(
          { accountId: params.ctx.accountId, channelId, messageTs },
          async () => {
            const { readSlackMessages } = await import("../../actions.js");
            const { messages } = await readSlackMessages(channelId, {
              client: params.eventScope?.client ?? params.ctx.app.client,
              messageId: messageTs,
              threadId: params.parsed.threadTs,
            });
            const current = messages[0];
            if (!hasSlackApprovalControl(current?.blocks, params.approval)) {
              return false;
            }
            await updateSlackInteractionMessage(params, {
              text: truncateSlackText(`${prefix}: ${terminalLabel}`, 4000),
              blocks: buildSlackApprovalTerminalBlocks({
                blocks: current?.blocks,
                label: terminalLabel,
                prefix,
              }),
            });
            return true;
          },
        );
      } catch {
        // Best-effort terminal presentation only; canonical Gateway state already won.
      }
    }
    if (!terminalized || !result.applied) {
      await respondEphemeral(
        params.respond,
        result.applied
          ? `Approval resolved: ${terminalLabel}.`
          : `This approval was already resolved: ${terminalLabel}.`,
      );
    }
  } catch (error) {
    params.ctx.runtime.log?.(
      `slack:interaction approval resolve failed id=${params.approval.approvalId}: ${String(error)}`,
    );
    // The clicker must see an outcome: pruned/expired records and gateway
    // outages otherwise ack the click silently (Discord's sibling responds).
    if (isApprovalNotFoundError(error)) {
      await respondEphemeral(params.respond, "This approval is no longer pending.");
      return true;
    }
    await respondEphemeral(
      params.respond,
      "Could not reach the Gateway to resolve this approval. Try again.",
    );
    throw error;
  }
  return true;
}

async function handleSlackLegacyApprovalInteraction(
  params: SlackBlockActionContext & { pluginInteractionData: string },
): Promise<boolean> {
  const parsedApproval = parseExecApprovalCommandText(params.pluginInteractionData);
  if (!parsedApproval) {
    return false;
  }
  const pluginSender = resolveSlackPluginApprovalSender({
    ctx: params.ctx,
    eventScope: params.eventScope,
    userId: params.parsed.userId,
  });
  const execAuthorized = isSlackExecApprovalAuthorizedSender({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId,
    senderId: params.parsed.userId,
  });
  const resolveMethods: ChannelApprovalKind[] = [];
  if (execAuthorized) {
    resolveMethods.push("exec");
  }
  if (pluginSender.authorized) {
    resolveMethods.push("plugin");
  }
  if (resolveMethods.length === 0) {
    params.ctx.runtime.log?.(
      `slack:interaction drop legacy approval user=${params.parsed.userId} (not authorized)`,
    );
    await respondEphemeral(params.respond, "You are not authorized to approve this request.");
    return true;
  }

  for (const [index, resolveMethod] of resolveMethods.entries()) {
    try {
      await resolveApprovalOverGateway({
        cfg: params.ctx.cfg,
        approvalId: parsedApproval.approvalId,
        decision: parsedApproval.decision,
        channel: "slack",
        accountId: params.ctx.accountId,
        senderId: resolveMethod === "plugin" ? pluginSender.senderId : params.parsed.userId,
        resolveMethod,
      });
      try {
        await updateSlackInteractionMessage(params, {
          text: params.parsed.typedBody.message?.text ?? "",
          blocks: [],
        });
      } catch {
        // Best-effort cleanup only for historical command-backed controls.
      }
      return true;
    } catch (error) {
      if (index + 1 < resolveMethods.length && isApprovalNotFoundError(error)) {
        continue;
      }
      params.ctx.runtime.log?.(
        `slack:interaction legacy approval resolve failed id=${parsedApproval.approvalId}: ${String(error)}`,
      );
      throw error;
    }
  }
  return true;
}

async function dispatchSlackPluginInteraction(
  params: SlackBlockActionContext & {
    pluginInteractionData: string;
    auth: { isAuthorizedSender: boolean };
    channelType?: Parameters<typeof dispatchSlackPluginInteractiveHandler>[0]["channelType"];
  },
): Promise<boolean> {
  const pluginInteractionId = buildSlackPluginInteractionId(params.parsed);
  if (await handleSlackPluginBindingApproval(params)) {
    return true;
  }
  const reply: SlackInteractiveHandlerContext["respond"]["reply"] = async ({
    text,
    responseType,
  }) => {
    if (text) {
      await params.respond?.({ text, response_type: responseType ?? "ephemeral" });
    }
  };
  const pluginResult = await dispatchSlackPluginInteractiveHandler({
    data: params.pluginInteractionData,
    interactionId: pluginInteractionId,
    teamId: params.eventScope?.teamId,
    channelType: params.channelType,
    ctx: {
      accountId: params.ctx.accountId,
      interactionId: pluginInteractionId,
      conversationId: params.parsed.channelId ?? "",
      parentConversationId: undefined,
      threadId: params.parsed.threadTs,
      senderId: params.parsed.userId,
      senderUsername: undefined,
      auth: params.auth,
      interaction: {
        kind: params.parsed.actionSummary.actionType === "button" ? "button" : "select",
        actionId: params.parsed.actionId,
        blockId: params.parsed.blockId,
        messageTs: params.parsed.messageTs,
        threadTs: params.parsed.threadTs,
        value: params.parsed.actionSummary.value,
        selectedValues: params.parsed.actionSummary.selectedValues,
        selectedLabels: params.parsed.actionSummary.selectedLabels,
        triggerId: params.parsed.typedBody.trigger_id,
        responseUrl: params.parsed.typedBody.response_url,
      },
    },
    respond: {
      acknowledge: async () => {},
      reply,
      followUp: reply,
      editMessage: async ({ text, blocks }) => {
        await updateSlackInteractionMessage(params, {
          text: text ?? params.parsed.typedBody.message?.text ?? "",
          blocks: Array.isArray(blocks) ? (blocks as (Block | KnownBlock)[]) : undefined,
        });
      },
    },
  });
  return pluginResult.matched && pluginResult.handled;
}

async function resolveSlackBlockActionCommandAuthorized(
  params: SlackBlockActionContext & {
    auth: { channelType?: "im" | "mpim" | "channel" | "group"; channelName?: string };
  },
): Promise<boolean> {
  const commandsAllowFrom = params.ctx.cfg.commands?.allowFrom;
  const commandsAllowFromConfigured =
    commandsAllowFrom != null &&
    typeof commandsAllowFrom === "object" &&
    (Array.isArray(commandsAllowFrom.slack) || Array.isArray(commandsAllowFrom["*"]));
  if (commandsAllowFromConfigured) {
    return (
      await resolveCommandAuthorizationAsync({
        ctx: {
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          AccountId: params.ctx.accountId,
          ChatType: params.auth.channelType === "im" ? "direct" : "group",
          From: params.parsed.channelId ? `slack:${params.parsed.channelId}` : "slack",
          SenderId: params.parsed.userId,
        },
        cfg: params.ctx.cfg,
        commandAuthorized: false,
      })
    ).isAuthorizedSender;
  }

  const isDirectMessage = params.auth.channelType === "im";
  const isRoom = params.auth.channelType === "channel" || params.auth.channelType === "group";
  const allowFromLower = await resolveSlackEffectiveAllowFrom(params.ctx, {
    includePairingStore: isDirectMessage,
    eventScope: params.eventScope,
  });
  const sender = await params.ctx
    .resolveUserName(params.parsed.userId, params.eventScope)
    .catch(() => undefined);
  const senderName = sender?.name;

  let channelUsers: Array<string | number> = [];
  if (isRoom && params.parsed.channelId) {
    const channelConfig = resolveSlackChannelConfig({
      teamId: params.eventScope?.teamId ?? params.ctx.teamId,
      allowUnscoped: params.ctx.installationIdentity?.kind !== "enterprise",
      channelId: params.parsed.channelId,
      channelName: params.auth.channelName,
      channels: params.ctx.channelsConfig,
      channelKeys: params.ctx.channelsConfigKeys,
      defaultRequireMention: params.ctx.defaultRequireMention,
      allowNameMatching: params.ctx.allowNameMatching,
    });
    channelUsers = Array.isArray(channelConfig?.users) ? channelConfig.users : [];
  }

  const commandIngress = await resolveSlackCommandIngress({
    ctx: params.ctx,
    teamId: params.eventScope?.teamId ?? params.ctx.teamId,
    senderId: params.parsed.userId,
    senderName,
    channelType: params.auth.channelType ?? "channel",
    channelId: params.parsed.channelId ?? "slack-interaction",
    ownerAllowFromLower: allowFromLower,
    channelUsers,
    allowTextCommands: false,
    hasControlCommand: true,
    eventKind: "button",
    modeWhenAccessGroupsOff: "configured",
  });
  return commandIngress.commandAccess.authorized;
}

async function enqueueSlackBlockActionEvent(
  params: SlackBlockActionContext & {
    teamId?: string;
    auth: { channelType?: "im" | "mpim" | "channel" | "group" };
  },
): Promise<void> {
  const targetKind = params.auth.channelType === "im" ? "user" : "channel";
  const targetId = targetKind === "user" ? params.parsed.userId : params.parsed.channelId;
  const deferredTarget = targetId
    ? resolveSlackDeferredActionTarget({
        eventScope: params.eventScope,
        kind: targetKind,
        id: targetId,
      })
    : undefined;
  const eventPayload = {
    interactionType: "block_action",
    actionId: params.parsed.actionId,
    blockId: params.parsed.blockId,
    ...params.parsed.actionSummary,
    userId: params.parsed.userId,
    teamId: params.teamId,
    triggerId: params.parsed.typedBody.trigger_id,
    responseUrl: params.parsed.typedBody.response_url,
    channelId: params.parsed.channelId,
    messageTs: params.parsed.messageTs,
    threadTs: params.parsed.threadTs,
  };
  params.ctx.runtime.log?.(
    `slack:interaction action=${params.parsed.actionId} type=${params.parsed.actionSummary.actionType ?? "unknown"} user=${params.parsed.userId} channel=${params.parsed.channelId}`,
  );
  const route = await params.ctx.resolveSlackSystemEventRoute({
    channelId: params.parsed.channelId,
    channelType: params.auth.channelType,
    senderId: params.parsed.userId,
    threadTs: params.parsed.threadTs,
    eventScope: params.eventScope,
  });
  const contextParts = [
    "slack:interaction",
    params.teamId,
    params.parsed.channelId,
    params.parsed.messageTs,
    params.parsed.actionId,
    normalizeOptionalString(params.parsed.typedActionWithText.action_ts) ??
      params.parsed.typedBody.trigger_id,
  ].filter(Boolean);
  enqueueSlackInteractionEvent(eventPayload, route, {
    contextKey: contextParts.join(":"),
    deliveryContext: {
      channel: "slack",
      to: deferredTarget?.target,
      accountId: params.ctx.accountId,
      threadId: params.parsed.threadTs,
    },
  });
}

function buildSlackConfirmationBlocks(params: {
  parsed: ParsedSlackBlockAction;
  originalBlocks: unknown[];
}): (Block | KnownBlock)[] {
  const selectedLabel = formatInteractionSelectionLabel({
    actionId: params.parsed.actionId,
    summary: params.parsed.actionSummary,
    buttonText: params.parsed.typedActionWithText.text?.text,
  });
  const userId = normalizeOptionalString(params.parsed.userId);
  const actor = userId ? ` by <@${userId}>` : "";
  return params.originalBlocks.map((block) => {
    const typedBlock = block as InteractionMessageBlock;
    if (typedBlock.type === "actions" && typedBlock.block_id === params.parsed.blockId) {
      return {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `:white_check_mark: *${escapeSlackMrkdwn(selectedLabel)}* selected${actor}`,
          },
        ],
      };
    }
    return block;
  }) as (Block | KnownBlock)[];
}

async function updateSlackLegacyBlockAction(params: SlackBlockActionContext): Promise<void> {
  const originalBlocks = params.parsed.typedBody.message?.blocks;
  if (
    !Array.isArray(originalBlocks) ||
    !params.parsed.channelId ||
    !params.parsed.messageTs ||
    !params.parsed.blockId
  ) {
    return;
  }
  try {
    await updateSlackInteractionMessage(params, {
      text: params.parsed.typedBody.message?.text ?? "",
      blocks: buildSlackConfirmationBlocks({
        parsed: params.parsed,
        originalBlocks,
      }),
    });
  } catch {
    await respondEphemeral(params.respond, `Button "${params.parsed.actionId}" clicked!`);
  }
}

export function registerSlackBlockActionHandler(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}): void {
  if (typeof params.ctx.app.action !== "function") {
    return;
  }
  params.ctx.app.action(/.+/, async (args: SlackBlockActionHandlerArgs) => {
    const { ack, body, action, respond } = args;
    await ack();
    const runtimeContext = await params.ctx.readRuntimeContext();
    const eventScope = resolveSlackMonitorEventScope({
      ctx: runtimeContext,
      body,
      context: args.context,
      client: args.client,
      onDrop: (reason) => runtimeContext.runtime.log?.(`slack:interaction drop action ${reason}`),
    });
    if (eventScope === null) {
      return;
    }
    if (runtimeContext.shouldDropMismatchedSlackEvent?.(body)) {
      runtimeContext.runtime.log?.(
        "slack:interaction drop block action payload (mismatched app/team)",
      );
      return;
    }
    const parsed = parseSlackBlockAction({
      body,
      action,
      log: runtimeContext.runtime.log,
    });
    if (!parsed) {
      return;
    }
    // Slack reports URL-button clicks too; navigation must not enqueue an agent interaction.
    if (isSlackReplyLinkAction(parsed)) {
      return;
    }
    params.trackEvent?.();
    const actionContext: SlackBlockActionContext = {
      ctx: runtimeContext,
      eventScope,
      parsed,
      respond,
    };
    if (isSlackApprovalActionId(parsed.actionId)) {
      const approval = decodeSlackApprovalAction(resolveSlackActionValue(parsed.actionSummary));
      if (!approval) {
        runtimeContext.runtime.log?.(
          `slack:interaction drop malformed approval action user=${parsed.userId} channel=${parsed.channelId ?? "unknown"}`,
        );
        await respondEphemeral(respond, "This approval action is invalid or expired.");
        return;
      }
      await handleSlackApprovalInteraction({ ...actionContext, approval });
      return;
    }
    if (isSlackQuestionActionId(parsed.actionId)) {
      const question = decodeSlackQuestionAction(parsed.actionSummary.value);
      if (!question) {
        await respondEphemeral(respond, "This question action is invalid or expired.");
        return;
      }
      const auth = await authorizeSlackBlockAction(actionContext);
      if (!auth.allowed) {
        return;
      }
      await resolveSlackQuestionAction({
        action: question,
        cfg: runtimeContext.cfg,
        accountId: runtimeContext.accountId,
        userId: parsed.userId,
        respond: async (text) => await respondEphemeral(respond, text),
      });
      return;
    }
    const pluginInteractionData = buildSlackPluginInteractionData({
      actionId: parsed.actionId,
      summary: parsed.actionSummary,
    });
    if (pluginInteractionData && isSlackReplyActionId(parsed.actionId)) {
      const handledExecApproval = await handleSlackLegacyApprovalInteraction({
        ...actionContext,
        pluginInteractionData,
      });
      if (handledExecApproval) {
        return;
      }
    }
    const auth = await authorizeSlackBlockAction(actionContext);
    if (!auth.allowed) {
      return;
    }
    if (pluginInteractionData && isSlackReplyActionId(parsed.actionId)) {
      const handledBindingApproval = await handleSlackPluginBindingApproval({
        ...actionContext,
        pluginInteractionData,
      });
      if (handledBindingApproval) {
        return;
      }
    } else if (pluginInteractionData) {
      const isAuthorizedSender = await resolveSlackBlockActionCommandAuthorized({
        ...actionContext,
        auth,
      });
      const handled = await dispatchSlackPluginInteraction({
        ...actionContext,
        pluginInteractionData,
        auth: {
          isAuthorizedSender,
        },
        channelType: auth.channelType,
      });
      if (handled) {
        return;
      }
    }
    await enqueueSlackBlockActionEvent({
      ...actionContext,
      teamId: args.context.teamId,
      auth,
    });
    await updateSlackLegacyBlockAction(actionContext);
  });
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
