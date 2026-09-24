import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { serializeMSTeamsAdaptiveCardActionValue } from "./adaptive-card-submit.js";
import { maybeHandleMSTeamsApprovalCardSubmit } from "./approval-card-submit.js";
import { formatUnknownError } from "./errors.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import { createMSTeamsReactionHandler } from "./monitor-handler/reaction-handler.js";
import type { MSTeamsIngressDispatchResult, MSTeamsIngressLifecycle } from "./msteams-ingress.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { buildGroupWelcomeText, buildWelcomeCard } from "./welcome-card.js";

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
  const maybeInvokeName = includeInvokeName ? { name: context.activity.name } : undefined;

  if (resolved.hasConflictingConversationScope) {
    deps.log.info("dropping invoke (conflicting conversation scope)", {
      conversationId,
      ...maybeInvokeName,
    });
    return false;
  }

  if (!msteamsCfg) {
    return true;
  }

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

export function createMSTeamsActivityHandler(deps: MSTeamsMessageHandlerDeps) {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);
  const handleReaction = createMSTeamsReactionHandler(deps);

  const handleMembersAdded = async (ctx: MSTeamsTurnContext) => {
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
          const card = buildWelcomeCard({
            botName,
            promptStarters: msteamsCfg?.promptStarters,
          });
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
            await ctx.sendActivity(buildGroupWelcomeText(botName));
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
  };

  return async (
    context: MSTeamsTurnContext,
    turnAdoptionLifecycle?: MSTeamsIngressLifecycle,
  ): Promise<MSTeamsIngressDispatchResult | void> => {
    const activity = context.activity;
    // Poll votes are intercepted by monitor.ts, which returns the HTTP invoke response.
    if (activity?.type === "invoke" && activity.name === "adaptiveCard/action") {
      if (await maybeHandleMSTeamsApprovalCardSubmit({ context, deps })) {
        return;
      }
      const text = serializeMSTeamsAdaptiveCardActionValue(activity.value);
      if (text) {
        return handleTeamsMessage(
          { ...context, activity: { ...activity, type: "message", text } },
          turnAdoptionLifecycle,
        );
      }
      return;
    }

    if (activity?.type === "message") {
      try {
        if (await maybeHandleMSTeamsApprovalCardSubmit({ context, deps })) {
          return;
        }
        return await handleTeamsMessage(context, turnAdoptionLifecycle);
      } catch (err) {
        if (turnAdoptionLifecycle) {
          throw err;
        }
        deps.runtime.error(`msteams handler failed: ${formatUnknownError(err)}`);
      }
    } else if (activity?.type === "conversationUpdate") {
      await handleMembersAdded(context);
    } else if (activity?.type === "messageReaction") {
      for (const direction of ["added", "removed"] as const) {
        const reactions =
          direction === "added" ? activity.reactionsAdded : activity.reactionsRemoved;
        if (!(reactions as unknown[] | undefined)?.length) {
          continue;
        }
        try {
          await handleReaction(context, direction);
        } catch (err) {
          deps.runtime.error(`msteams reaction handler failed: ${String(err)}`);
        }
      }
    }
  };
}
