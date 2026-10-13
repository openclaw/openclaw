import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMSTeamsAccountConfig } from "./accounts.js";
import { serializeMSTeamsAdaptiveCardActionValue } from "./adaptive-card-submit.js";
import { maybeHandleMSTeamsApprovalCardSubmit } from "./approval-card-submit.js";
import { formatUnknownError } from "./errors.js";
import { buildMSTeamsAdaptiveCardActivity } from "./message-activity.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import { createMSTeamsReactionHandler } from "./monitor-handler/reaction-handler.js";
import type { MSTeamsIngressDispatchResult, MSTeamsIngressLifecycle } from "./msteams-ingress.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { buildGroupWelcomeText, buildWelcomeCard } from "./welcome-card.js";

export async function isMSTeamsInvokeAuthorized(params: {
  context: Pick<MSTeamsTurnContext, "activity">;
  deps: MSTeamsMessageHandlerDeps;
  invokeKind: "feedback" | "signin" | "card action";
}): Promise<boolean> {
  const { context, deps, invokeKind } = params;
  const cfg = deps.readConfig?.() ?? deps.cfg;
  const account = resolveMSTeamsAccountConfig(cfg, deps.accountId);
  if (account.enabled === false || (account.appId && account.appId !== deps.appId)) {
    return false;
  }
  const resolved = await resolveMSTeamsSenderAccess({
    cfg,
    accountId: deps.accountId,
    activity: context.activity,
  });
  const { msteamsCfg, isDirectMessage, conversationId, senderId } = resolved;
  const maybeInvokeName = invokeKind === "feedback" ? undefined : { name: context.activity.name };

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
    deps.log.debug?.(`dropping ${invokeKind} invoke (dm sender not allowlisted)`, {
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
    deps.log.debug?.(`dropping ${invokeKind} invoke (not in team/channel allowlist)`, {
      conversationId,
      teamKey: resolved.channelGate.teamKey ?? "none",
      channelKey: resolved.channelGate.channelKey ?? "none",
      ...maybeInvokeName,
    });
    return false;
  }

  if (!isDirectMessage && !resolved.senderAccess.allowed) {
    deps.log.debug?.(`dropping ${invokeKind} invoke (group sender not allowlisted)`, {
      sender: senderId,
      conversationId,
      ...maybeInvokeName,
    });
    return false;
  }

  return true;
}

export function createMSTeamsActivityHandler(deps: MSTeamsMessageHandlerDeps) {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);
  const handleReaction = createMSTeamsReactionHandler(deps);

  const handleMembersAdded = async (ctx: MSTeamsTurnContext) => {
    const membersAdded = ctx.activity?.membersAdded ?? [];
    const botId = ctx.activity?.recipient?.id;
    const msteamsCfg = deps.cfg.channels?.msteams
      ? resolveMSTeamsAccountConfig(deps.cfg, deps.accountId)
      : undefined;

    for (const member of membersAdded) {
      if (member.id === botId) {
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
            await ctx.sendActivity(buildMSTeamsAdaptiveCardActivity(card));
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
        if (!reactions?.length) {
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
