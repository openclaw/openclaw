// Msteams plugin module implements monitor handler behavior.
import {
  isRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { redactOutboundMSTeamsCard, redactOutboundMSTeamsText } from "./dlp.js";
import { formatUnknownError } from "./errors.js";
import { buildMessageActionPrompt, type MSTeamsMessageActionValue } from "./message-action.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import { createMSTeamsReactionHandler } from "./monitor-handler/reaction-handler.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { buildGroupWelcomeText, buildWelcomeCard } from "./welcome-card.js";
export type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";

export type MSTeamsActivityHandler = {
  onMessage: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onMembersAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onReactionsAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onReactionsRemoved: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  run?: (context: unknown) => Promise<void>;
};

function extractAdaptiveCardSubmittedData(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const action = isRecord(value.action) ? value.action : undefined;
  if (
    action &&
    normalizeOptionalLowercaseString(action.type) === "action.submit" &&
    "data" in action
  ) {
    return action.data;
  }
  return value;
}

function readMSTeamsImBackValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const msteams = isRecord(value.msteams) ? value.msteams : undefined;
  if (!msteams || normalizeOptionalLowercaseString(msteams.type) !== "imback") {
    return null;
  }
  return normalizeOptionalString(msteams.value) ?? null;
}

/**
 * Synthetic message activity for an invoke-driven dispatch (card action / message action). The user
 * explicitly invoked the bot, so stamp a bot-mention entity: without it `wasMSTeamsBotMentioned` is
 * false and group-chat mention-gating silently drops the dispatch right after the "On it" ack —
 * the reply never comes, and the quoted prompt only pollutes the group history.
 */
function buildInvokeDispatchActivity(
  activity: MSTeamsTurnContext["activity"],
  text: string,
): MSTeamsTurnContext["activity"] {
  const botId = activity.recipient?.id;
  return {
    ...activity,
    type: "message",
    text,
    entities: [
      ...(activity.entities ?? []),
      ...(botId
        ? [{ type: "mention", mentioned: { id: botId, name: activity.recipient?.name ?? "" } }]
        : []),
    ],
  };
}

function serializeAdaptiveCardActionValue(value: unknown): string | null {
  const submittedValue = extractAdaptiveCardSubmittedData(value);
  if (typeof submittedValue === "string") {
    const trimmed = submittedValue.trim();
    return trimmed ? trimmed : null;
  }
  const imBackValue = readMSTeamsImBackValue(submittedValue);
  if (imBackValue) {
    return imBackValue;
  }
  if (submittedValue == null) {
    return null;
  }
  try {
    return JSON.stringify(submittedValue);
  } catch {
    return null;
  }
}

async function isInvokeAuthorized(params: {
  context: MSTeamsTurnContext;
  deps: MSTeamsMessageHandlerDeps;
  deniedLogs: {
    dm: string;
    channel: string;
    group: string;
  };
  includeInvokeName?: boolean;
}): Promise<boolean> {
  const { context, deps, deniedLogs, includeInvokeName = false } = params;
  const resolved = await resolveMSTeamsSenderAccess({
    cfg: deps.cfg,
    activity: context.activity,
  });
  const { msteamsCfg, isDirectMessage, conversationId, senderId } = resolved;
  if (!msteamsCfg) {
    return true;
  }

  const maybeInvokeName = includeInvokeName ? { name: context.activity.name } : undefined;

  if (isDirectMessage && resolved.senderAccess.decision !== "allow") {
    deps.log.debug?.(deniedLogs.dm, {
      sender: senderId,
      conversationId,
      ...maybeInvokeName,
    });
    return false;
  }

  if (
    !isDirectMessage &&
    resolved.channelGate.allowlistConfigured &&
    !resolved.channelGate.allowed
  ) {
    deps.log.debug?.(deniedLogs.channel, {
      conversationId,
      teamKey: resolved.channelGate.teamKey ?? "none",
      channelKey: resolved.channelGate.channelKey ?? "none",
      ...maybeInvokeName,
    });
    return false;
  }

  if (!isDirectMessage && !resolved.senderAccess.allowed) {
    deps.log.debug?.(deniedLogs.group, {
      sender: senderId,
      conversationId,
      ...maybeInvokeName,
    });
    return false;
  }

  return true;
}

export async function isFeedbackInvokeAuthorized(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  return isInvokeAuthorized({
    context,
    deps,
    deniedLogs: {
      dm: "dropping feedback invoke (dm sender not allowlisted)",
      channel: "dropping feedback invoke (not in team/channel allowlist)",
      group: "dropping feedback invoke (group sender not allowlisted)",
    },
  });
}

export async function isSigninInvokeAuthorized(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  return isInvokeAuthorized({
    context,
    deps,
    deniedLogs: {
      dm: "dropping signin invoke (dm sender not allowlisted)",
      channel: "dropping signin invoke (not in team/channel allowlist)",
      group: "dropping signin invoke (group sender not allowlisted)",
    },
    includeInvokeName: true,
  });
}

export async function isCardActionInvokeAuthorized(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  return isInvokeAuthorized({
    context,
    deps,
    deniedLogs: {
      dm: "dropping card action invoke (dm sender not allowlisted)",
      channel: "dropping card action invoke (not in team/channel allowlist)",
      group: "dropping card action invoke (group sender not allowlisted)",
    },
    includeInvokeName: true,
  });
}

export function registerMSTeamsHandlers<T extends MSTeamsActivityHandler>(
  handler: T,
  deps: MSTeamsMessageHandlerDeps,
): T {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);
  const handleReaction = createMSTeamsReactionHandler(deps);

  // Wrap the original run method to intercept invokes
  const originalRun = handler.run;
  if (originalRun) {
    handler.run = async (context: unknown) => {
      const ctx = context as MSTeamsTurnContext;
      // Non-poll adaptiveCard/action invokes get dispatched here as text so the
      // agent can react. Poll votes are intercepted in monitor.ts's
      // app.on("card.action") handler which returns the InvokeResponse to Teams.
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "adaptiveCard/action") {
        const text = serializeAdaptiveCardActionValue(ctx.activity?.value);
        if (text) {
          await handleTeamsMessage({
            ...ctx,
            activity: buildInvokeDispatchActivity(ctx.activity, text),
          });
        }
        return;
      }

      // Message action ("Ask OpenClaw about this", #10): the selected message arrives on a
      // composeExtension/submitAction invoke. Quote it into a prompt and dispatch as a normal
      // message so the reply lands in the conversation (same path as adaptiveCard/action above).
      if (
        ctx.activity?.type === "invoke" &&
        ctx.activity?.name === "composeExtension/submitAction"
      ) {
        const prompt = buildMessageActionPrompt(ctx.activity?.value as MSTeamsMessageActionValue);
        if (prompt) {
          await handleTeamsMessage({
            ...ctx,
            activity: buildInvokeDispatchActivity(ctx.activity, prompt),
          });
        }
        return;
      }

      return originalRun.call(handler, context);
    };
  }

  handler.onMessage(async (context, next) => {
    try {
      await handleTeamsMessage(context as MSTeamsTurnContext);
    } catch (err) {
      deps.runtime.error(`msteams handler failed: ${formatUnknownError(err)}`);
    }
    await next();
  });

  handler.onMembersAdded(async (context, next) => {
    const ctx = context as MSTeamsTurnContext;
    const membersAdded = ctx.activity?.membersAdded ?? [];
    const botId = ctx.activity?.recipient?.id;
    const msteamsCfg = deps.cfg.channels?.msteams;

    for (const member of membersAdded) {
      if (member.id === botId) {
        // Bot was added to a conversation — send welcome card if configured.
        const conversationType =
          normalizeOptionalLowercaseString(ctx.activity?.conversation?.conversationType) ??
          "personal";
        const isPersonal = conversationType === "personal";

        if (isPersonal && msteamsCfg?.welcomeCard !== false) {
          const botName = ctx.activity?.recipient?.name ?? undefined;
          // DLP (#16): the welcome card carries config-authored prompt-starters, which can embed
          // secrets — deep-redact it like every other outbound card path so this isn't a bypass.
          const card = redactOutboundMSTeamsCard(
            buildWelcomeCard({
              botName,
              promptStarters: msteamsCfg?.promptStarters,
            }),
            deps.cfg,
          );
          try {
            await ctx.sendActivity({
              type: "message",
              attachments: [
                {
                  contentType: "application/vnd.microsoft.card.adaptive",
                  content: card,
                },
              ],
            });
            deps.log.info("sent welcome card");
          } catch (err) {
            deps.log.debug?.("failed to send welcome card", { error: formatUnknownError(err) });
          }
        } else if (!isPersonal && msteamsCfg?.groupWelcomeCard === true) {
          const botName = ctx.activity?.recipient?.name ?? undefined;
          try {
            // DLP (#16): redact the group welcome text on the same outbound boundary as the card.
            await ctx.sendActivity(
              redactOutboundMSTeamsText(buildGroupWelcomeText(botName), deps.cfg),
            );
            deps.log.info("sent group welcome message");
          } catch (err) {
            deps.log.debug?.("failed to send group welcome", { error: formatUnknownError(err) });
          }
        } else {
          deps.log.debug?.("skipping welcome (disabled by config or conversation type)");
        }
      } else {
        deps.log.debug?.("member added", { member: member.id });
      }
    }
    await next();
  });

  handler.onReactionsAdded(async (context, next) => {
    try {
      await handleReaction(context as MSTeamsTurnContext, "added");
    } catch (err) {
      deps.runtime.error(`msteams reaction handler failed: ${String(err)}`);
    }
    await next();
  });

  handler.onReactionsRemoved(async (context, next) => {
    try {
      await handleReaction(context as MSTeamsTurnContext, "removed");
    } catch (err) {
      deps.runtime.error(`msteams reaction handler failed: ${String(err)}`);
    }
    await next();
  });

  return handler;
}
