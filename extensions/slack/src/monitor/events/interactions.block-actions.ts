import type { Block, KnownBlock } from "@slack/web-api";
import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { formatApprovalDecisionLabel } from "openclaw/plugin-sdk/approval-runtime";
import { resolveCommandAuthorizationAsync } from "openclaw/plugin-sdk/command-auth-native";
import {
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
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
import { isSlackApprovalActionId, isSlackQuestionActionId } from "../../reply-action-ids.js";
import { truncateSlackText } from "../../truncate.js";
import {
  authorizeSlackSystemEventSender,
  resolveSlackCommandIngress,
  resolveSlackEffectiveAllowFrom,
} from "../auth.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackDeferredActionTarget } from "../deferred-action-routing.js";
import { resolveSlackMonitorEventScope } from "../event-scope.js";
import { escapeSlackMrkdwn } from "../mrkdwn.js";
import {
  captureSlackInteractionEventRoute,
  enqueueSlackInteractionEvent,
} from "./interaction-event.js";
import { resolveSlackPluginApprovalSender } from "./interactions.approval-sender.js";
import {
  buildSlackPluginInteractionData,
  buildSlackPluginInteractionId,
  isSlackReplyActionId,
  isSlackReplyLinkAction,
  parseSlackBlockAction,
  resolveSlackActionValue,
  type SlackBlockActionContext,
  type SlackBlockActionHandlerArgs,
  type SlackBlockActionRespond,
} from "./interactions.block-actions.context.js";
import { formatInteractionSelectionLabel } from "./modal-input-summary.js";

type InteractionMessageBlock = {
  type?: string;
  block_id?: string;
  elements?: Array<{ action_id?: string }>;
};

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
  if (approval.status === "allowed" || approval.status === "denied") {
    return formatApprovalDecisionLabel(approval.decision);
  }
  return approval.status === "expired" ? "Expired" : "Cancelled";
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
            const blocks = removeSlackApprovalControls(current?.blocks ?? []).filter((block) => {
              const blockId = (block as { block_id?: unknown }).block_id;
              return !(
                (block as { type?: unknown }).type === "section" &&
                blockId === SLACK_APPROVAL_HEADER_BLOCK_ID
              );
            });
            await updateSlackInteractionMessage(params, {
              text: truncateSlackText(`${prefix}: ${terminalLabel}`, 4000),
              blocks: [
                {
                  type: "section",
                  text: { type: "mrkdwn", text: `*${prefix}: ${terminalLabel}*` },
                },
                ...blocks,
              ],
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
    channelUsers = channelConfig?.users ?? [];
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
    const selectedLabel = formatInteractionSelectionLabel({
      actionId: params.parsed.actionId,
      summary: params.parsed.actionSummary,
      buttonText: params.parsed.typedActionWithText.text?.text,
    });
    const userId = normalizeOptionalString(params.parsed.userId);
    const actor = userId ? ` by <@${userId}>` : "";
    await updateSlackInteractionMessage(params, {
      text: params.parsed.typedBody.message?.text ?? "",
      blocks: originalBlocks.map((block) => {
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
      }) as (Block | KnownBlock)[],
    });
  } catch {
    await respondEphemeral(params.respond, `Button "${params.parsed.actionId}" clicked!`);
  }
}

export function registerSlackBlockActionHandler(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}): void {
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
    const parsed = parseSlackBlockAction({ body, action, log: runtimeContext.runtime.log });
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
    const destination = await runtimeContext.resolveSlackSystemEventRoute({
      channelId: parsed.channelId,
      channelType: auth.channelType,
      senderId: parsed.userId,
      threadTs: parsed.threadTs,
      eventScope,
    });
    const route = await captureSlackInteractionEventRoute(destination, runtimeContext.runtime.log);
    if (!runtimeContext.isRuntimePolicyCurrent()) {
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
      if (!runtimeContext.isRuntimePolicyCurrent()) {
        return;
      }
      const pluginInteractionId = buildSlackPluginInteractionId(parsed);
      if (
        await handleSlackPluginBindingApproval({
          ...actionContext,
          pluginInteractionData,
        })
      ) {
        return;
      }
      const reply: SlackInteractiveHandlerContext["respond"]["reply"] = async ({
        text,
        responseType,
      }) => {
        if (text) {
          await respond?.({ text, response_type: responseType ?? "ephemeral" });
        }
      };
      const pluginResult = await dispatchSlackPluginInteractiveHandler({
        data: pluginInteractionData,
        interactionId: pluginInteractionId,
        teamId: eventScope?.teamId,
        channelType: auth.channelType,
        ctx: {
          accountId: runtimeContext.accountId,
          interactionId: pluginInteractionId,
          conversationId: parsed.channelId ?? "",
          parentConversationId: undefined,
          threadId: parsed.threadTs,
          senderId: parsed.userId,
          senderUsername: undefined,
          auth: { isAuthorizedSender },
          interaction: {
            kind: parsed.actionSummary.actionType === "button" ? "button" : "select",
            actionId: parsed.actionId,
            blockId: parsed.blockId,
            messageTs: parsed.messageTs,
            threadTs: parsed.threadTs,
            value: parsed.actionSummary.value,
            selectedValues: parsed.actionSummary.selectedValues,
            selectedLabels: parsed.actionSummary.selectedLabels,
            triggerId: parsed.typedBody.trigger_id,
            responseUrl: parsed.typedBody.response_url,
          },
        },
        respond: {
          acknowledge: async () => {},
          reply,
          followUp: reply,
          editMessage: async ({ text, blocks }) => {
            await updateSlackInteractionMessage(actionContext, {
              text: text ?? parsed.typedBody.message?.text ?? "",
              blocks: Array.isArray(blocks) ? (blocks as (Block | KnownBlock)[]) : undefined,
            });
          },
        },
      });
      if (pluginResult.matched && pluginResult.handled) {
        return;
      }
    }
    if (!route || !runtimeContext.isRuntimePolicyCurrent()) {
      return;
    }
    const teamId = args.context.teamId;
    const targetKind = auth.channelType === "im" ? "user" : "channel";
    const targetId = targetKind === "user" ? parsed.userId : parsed.channelId;
    const deferredTarget = targetId
      ? resolveSlackDeferredActionTarget({
          eventScope,
          kind: targetKind,
          id: targetId,
        })
      : undefined;
    const eventPayload = {
      interactionType: "block_action",
      actionId: parsed.actionId,
      blockId: parsed.blockId,
      ...parsed.actionSummary,
      userId: parsed.userId,
      teamId,
      triggerId: parsed.typedBody.trigger_id,
      responseUrl: parsed.typedBody.response_url,
      channelId: parsed.channelId,
      messageTs: parsed.messageTs,
      threadTs: parsed.threadTs,
    };
    runtimeContext.runtime.log?.(
      `slack:interaction action=${parsed.actionId} type=${parsed.actionSummary.actionType ?? "unknown"} user=${parsed.userId} channel=${parsed.channelId}`,
    );
    const contextParts = [
      "slack:interaction",
      teamId,
      parsed.channelId,
      parsed.messageTs,
      parsed.actionId,
      normalizeOptionalString(parsed.typedActionWithText.action_ts) ?? parsed.typedBody.trigger_id,
    ].filter(Boolean);
    const accepted = await enqueueSlackInteractionEvent(
      eventPayload,
      route,
      {
        contextKey: contextParts.join(":"),
        deliveryContext: {
          channel: "slack",
          to: deferredTarget?.target,
          accountId: runtimeContext.accountId,
          threadId: parsed.threadTs,
        },
      },
      runtimeContext.runtime.log,
    );
    if (accepted && runtimeContext.isRuntimePolicyCurrent()) {
      await updateSlackLegacyBlockAction(actionContext);
    }
  });
}
