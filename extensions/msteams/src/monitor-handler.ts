// Msteams plugin module implements monitor handler behavior.
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { serializeMSTeamsAdaptiveCardActionValue } from "./adaptive-card-submit.js";
import { formatUnknownError } from "./errors.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import { createMSTeamsReactionHandler } from "./monitor-handler/reaction-handler.js";
import type { MSTeamsIngressDispatchResult, MSTeamsIngressLifecycle } from "./msteams-ingress.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { buildGroupWelcomeText, buildWelcomeCard } from "./welcome-card.js";

export type MSTeamsActivityHandler = {
  onMessage: (
    handler: (
      context: unknown,
      next: () => Promise<void>,
      turnAdoptionLifecycle?: MSTeamsIngressLifecycle,
    ) => Promise<MSTeamsIngressDispatchResult | void>,
  ) => MSTeamsActivityHandler;
  onMembersAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onMembersRemoved: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onInstallationUpdate: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onReactionsAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onReactionsRemoved: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  run?: (
    context: unknown,
    turnAdoptionLifecycle?: MSTeamsIngressLifecycle,
  ) => Promise<MSTeamsIngressDispatchResult | void>;
};

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
    handler.run = async (context: unknown, turnAdoptionLifecycle?: MSTeamsIngressLifecycle) => {
      const ctx = context as MSTeamsTurnContext;
      // Non-poll adaptiveCard/action invokes get dispatched here as text so the
      // agent can react. Poll votes are intercepted in monitor.ts's
      // app.on("card.action") handler which returns the InvokeResponse to Teams.
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "adaptiveCard/action") {
        const text = serializeMSTeamsAdaptiveCardActionValue(ctx.activity?.value);
        if (text) {
          return await handleTeamsMessage(
            {
              ...ctx,
              activity: {
                ...ctx.activity,
                type: "message",
                text,
              },
            },
            turnAdoptionLifecycle,
          );
        }
        return;
      }

      return originalRun.call(handler, context, turnAdoptionLifecycle);
    };
  }

  handler.onMessage(async (context, next, turnAdoptionLifecycle) => {
    let nextRan = false;
    const runNext = async () => {
      nextRan = true;
      await next();
    };
    try {
      const result = await handleTeamsMessage(context as MSTeamsTurnContext, turnAdoptionLifecycle);
      await runNext();
      return result;
    } catch (err) {
      if (turnAdoptionLifecycle) {
        throw err;
      }
      deps.runtime.error(`msteams handler failed: ${formatUnknownError(err)}`);
    }
    if (!nextRan) {
      await runNext();
    }
    return undefined;
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

  handler.onMembersRemoved(async (context, next) => {
    const ctx = context as MSTeamsTurnContext;
    const membersRemoved = ctx.activity?.membersRemoved ?? [];
    const botId = ctx.activity?.recipient?.id;
    const conversationId = ctx.activity?.conversation?.id;
    const conversationType = normalizeOptionalLowercaseString(
      ctx.activity?.conversation?.conversationType,
    );
    const activityFrom = ctx.activity?.from;

    // Check if the bot itself was removed from a personal DM conversation.
    for (const member of membersRemoved) {
      if (member.id === botId && conversationType === "personal") {
        // When bot is removed from a personal DM, we need to mark the user's session as stale.
        // The user who triggered the removal is in activity.from.
        const userId = activityFrom?.aadObjectId ?? activityFrom?.id;
        if (!userId) {
          deps.log.debug?.("cannot mark session stale: missing user id");
          continue;
        }

        deps.log.info("bot removed from personal DM, marking session as stale", {
          conversationId,
          userId,
          memberId: member.id,
        });

        // Build the session key for this user's DM conversations.
        // Session key shape follows the routing pattern used by inbound messages:
        // agent:<agentId>:msteams:direct:<userId> where agentId defaults to "main"
        const agentId = "main"; // Match DEFAULT_AGENT_ID used by routing
        const baseSessionKey = `agent:${agentId}:msteams:direct:${userId}`;

        // Mark all sessions for this user as stale by setting updatedAt to 0.
        // This preserves the transcript records but signals that new sessions
        // should be created on the next message.
        try {
          const storePath = resolveStorePath(deps.cfg.session?.store, { agentId });
          let resetCount = 0;

          // Iterate through all session entries and mark those matching this user as stale.
          // We need to check both the base key and any thread-qualified variants.
          const sessionKeyPrefix = `${baseSessionKey}:`;
          const exactSessionKey = baseSessionKey;

          // Import listSessionEntries dynamically to avoid circular dependencies
          const { listSessionEntries } = await import("openclaw/plugin-sdk/session-store-runtime");

          for (const { sessionKey, entry } of listSessionEntries({ storePath })) {
            // Match either exact key or keys with additional qualifiers (like thread IDs)
            if (sessionKey === exactSessionKey || sessionKey.startsWith(sessionKeyPrefix)) {
              if (entry.updatedAt === 0) {
                // Already marked as stale
                continue;
              }

              // Set updatedAt to 0 to mark as stale (following Discord's pattern)
              let resetEntry = false;
              const capturedEntry = entry; // Capture for use in closure
              await patchSessionEntry({
                storePath,
                sessionKey,
                replaceEntry: true,
                update: (current: SessionEntry) => {
                  if (current.updatedAt === 0) {
                    return null;
                  }
                  // Verify the entry hasn't changed since we read it
                  if (
                    current.updatedAt !== capturedEntry.updatedAt ||
                    current.sessionId !== capturedEntry.sessionId
                  ) {
                    return null;
                  }
                  resetEntry = true;
                  return { ...current, updatedAt: 0 };
                },
              });

              if (resetEntry) {
                resetCount += 1;
              }
            }
          }

          if (resetCount > 0) {
            deps.log.info(`marked ${resetCount} session(s) as stale for user ${userId}`);
          }
        } catch (err) {
          deps.log.debug?.("failed to mark sessions stale on removal", {
            error: formatUnknownError(err),
          });
        }
      } else {
        deps.log.debug?.("member removed", { member: member.id, conversationType });
      }
    }
    await next();
  });

  handler.onInstallationUpdate(async (context, next) => {
    const ctx = context as MSTeamsTurnContext;
    const activity = ctx.activity;
    const conversationId = activity?.conversation?.id;
    const conversationType = normalizeOptionalLowercaseString(
      activity?.conversation?.conversationType,
    );
    const activityFrom = activity?.from;

    // installationUpdate activities carry an action field indicating install/uninstall.
    // The eventType may also appear in channelData depending on SDK version.
    const action =
      (activity?.channelData as Record<string, unknown>)?.eventType ??
      (activity as Record<string, unknown>)?.action;

    deps.log.debug?.("installation update received", {
      action,
      conversationId,
      conversationType,
    });

    // Handle app removal/uninstallation in personal DM conversations.
    // Teams installationUpdate uses action values: remove, remove-upgrade
    const isRemovalAction = action === "remove" || action === "remove-upgrade";
    if (isRemovalAction && conversationType === "personal") {
      // When app is removed/uninstalled, mark the user's sessions as stale.
      const userId = activityFrom?.aadObjectId ?? activityFrom?.id;
      if (!userId) {
        deps.log.debug?.("cannot mark session stale on removal: missing user id");
        await next();
        return;
      }

      deps.log.info("app removed from personal DM, marking session as stale", {
        conversationId,
        userId,
      });

      // Build the session key for this user's DM conversations.
      // Session key shape follows the routing pattern used by inbound messages:
      // agent:<agentId>:msteams:direct:<userId> where agentId defaults to "main"
      const agentId = "main"; // Match DEFAULT_AGENT_ID used by routing
      const baseSessionKey = `agent:${agentId}:msteams:direct:${userId}`;

      try {
        const storePath = resolveStorePath(deps.cfg.session?.store, { agentId });
        let resetCount = 0;

        const sessionKeyPrefix = `${baseSessionKey}:`;
        const exactSessionKey = baseSessionKey;

        const { listSessionEntries } = await import("openclaw/plugin-sdk/session-store-runtime");

        for (const { sessionKey, entry } of listSessionEntries({ storePath })) {
          if (sessionKey === exactSessionKey || sessionKey.startsWith(sessionKeyPrefix)) {
            if (entry.updatedAt === 0) {
              continue;
            }

            let resetEntry = false;
            const capturedEntry = entry;
            await patchSessionEntry({
              storePath,
              sessionKey,
              replaceEntry: true,
              update: (current: SessionEntry) => {
                if (current.updatedAt === 0) {
                  return null;
                }
                if (
                  current.updatedAt !== capturedEntry.updatedAt ||
                  current.sessionId !== capturedEntry.sessionId
                ) {
                  return null;
                }
                resetEntry = true;
                return { ...current, updatedAt: 0 };
              },
            });

            if (resetEntry) {
              resetCount += 1;
            }
          }
        }

        if (resetCount > 0) {
          deps.log.info(`marked ${resetCount} session(s) as stale on uninstall for user ${userId}`);
        }
      } catch (err) {
        deps.log.debug?.("failed to mark sessions stale on uninstall", {
          error: formatUnknownError(err),
        });
      }
    }

    await next();
  });

  return handler;
}
