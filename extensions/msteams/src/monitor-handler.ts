import path from "node:path";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { appendRegularFile } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { formatUnknownError } from "./errors.js";
import { buildFeedbackEvent, runFeedbackReflection } from "./feedback-reflection.js";
import { respondToMSTeamsFileConsentInvoke } from "./file-consent-invoke.js";
import {
  extractMSTeamsConversationMessageId,
  htmlToPlainText,
  normalizeMSTeamsConversationId,
} from "./inbound.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import { createMSTeamsReactionHandler } from "./monitor-handler/reaction-handler.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import {
  handleSigninTokenExchangeInvoke,
  handleSigninVerifyStateInvoke,
  parseSigninTokenExchangeValue,
  parseSigninVerifyStateValue,
} from "./sso.js";
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

function serializeAdaptiveCardActionValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function extractSigninMagicCode(activity: MSTeamsTurnContext["activity"]): string | undefined {
  const rawText = typeof activity.text === "string" ? activity.text : "";
  const text = htmlToPlainText(rawText).trim();
  return /^\d{6}$/.test(text) ? text : undefined;
}

function resolveSigninUserCandidates(
  activity: MSTeamsTurnContext["activity"],
): Array<{ userId: string; channelId: string }> {
  const channelId = activity.channelId ?? "msteams";
  const seen = new Set<string>();
  const users: Array<{ userId: string; channelId: string }> = [];
  for (const rawUserId of [activity.from?.aadObjectId, activity.from?.id]) {
    const userId = rawUserId?.trim();
    if (!userId || seen.has(userId)) {
      continue;
    }
    seen.add(userId);
    users.push({ userId, channelId });
  }
  return users;
}

const SIGNIN_MAGIC_CODE_CHALLENGE_TTL_MS = 15 * 60 * 1000;

function resolveSigninChallengeKeys(activity: MSTeamsTurnContext["activity"]): string[] {
  const conversationId = activity.conversation?.id?.trim();
  if (!conversationId) {
    return [];
  }
  return resolveSigninUserCandidates(activity).map(
    (user) => `${user.channelId}\n${conversationId}\n${user.userId}`,
  );
}

function createSigninChallengeTracker(now: () => number = Date.now) {
  type Challenge = { keys: Set<string>; expiresAt: number };
  const challenges = new Map<string, Challenge>();

  function prune(): void {
    const timestamp = now();
    for (const [key, challenge] of challenges) {
      if (challenge.expiresAt <= timestamp) {
        challenges.delete(key);
      }
    }
  }

  return {
    record(activity: MSTeamsTurnContext["activity"]): void {
      prune();
      const keys = resolveSigninChallengeKeys(activity);
      if (keys.length === 0) {
        return;
      }
      const expiresAt = now() + SIGNIN_MAGIC_CODE_CHALLENGE_TTL_MS;
      const groupedKeys = new Set(keys);
      for (const key of keys) {
        const existing = challenges.get(key);
        if (!existing) {
          continue;
        }
        for (const existingKey of existing.keys) {
          groupedKeys.add(existingKey);
        }
      }
      const challenge: Challenge = { keys: groupedKeys, expiresAt };
      for (const key of groupedKeys) {
        challenges.set(key, challenge);
      }
    },
    has(activity: MSTeamsTurnContext["activity"]): boolean {
      prune();
      return resolveSigninChallengeKeys(activity).some((key) => challenges.has(key));
    },
    clear(activity: MSTeamsTurnContext["activity"]): void {
      prune();
      const cleared = new Set<Challenge>();
      for (const key of resolveSigninChallengeKeys(activity)) {
        const challenge = challenges.get(key);
        if (!challenge || cleared.has(challenge)) {
          continue;
        }
        cleared.add(challenge);
        for (const challengeKey of challenge.keys) {
          challenges.delete(challengeKey);
        }
      }
    },
  };
}

function normalizeSigninFailureValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const obj = value as Record<string, unknown>;
  return {
    code: typeof obj.code === "string" ? obj.code : undefined,
    message: typeof obj.message === "string" ? obj.message : undefined,
    connectionName: typeof obj.connectionName === "string" ? obj.connectionName : undefined,
  };
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

  if (isDirectMessage && resolved.access.decision !== "allow") {
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

  if (!isDirectMessage && !resolved.senderGroupAccess.allowed) {
    deps.log.debug?.(deniedLogs.group, {
      sender: senderId,
      conversationId,
      ...maybeInvokeName,
    });
    return false;
  }

  return true;
}

async function isFeedbackInvokeAuthorized(
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

async function isSigninInvokeAuthorized(
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

async function handleSigninMagicCodeMessage(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  const code = extractSigninMagicCode(context.activity);
  if (!code) {
    return false;
  }

  if (!deps.sso) {
    return false;
  }
  if (!deps.hasSsoSignInChallenge?.(context.activity)) {
    return false;
  }

  if (
    !(await isInvokeAuthorized({
      context,
      deps,
      deniedLogs: {
        dm: "dropping signin code message (dm sender not allowlisted)",
        channel: "dropping signin code message (not in team/channel allowlist)",
        group: "dropping signin code message (group sender not allowlisted)",
      },
    }))
  ) {
    return true;
  }

  const users = resolveSigninUserCandidates(context.activity);
  if (users.length === 0) {
    deps.log.error("msteams sso magic-code verification failed", {
      code: "missing_user",
      status: undefined,
      message: "no user id on message activity",
    });
    await context.sendActivity(
      "That sign-in code could not be verified. Open the latest sign-in link and try the new code.",
    );
    return true;
  }

  let lastFailure:
    | {
        code: string;
        status?: number;
        message: string;
      }
    | undefined;
  for (const user of users) {
    const result = await handleSigninVerifyStateInvoke({
      value: { state: code },
      user,
      deps: deps.sso,
    });
    if (result.ok) {
      deps.log.info("msteams sso magic-code verification succeeded", {
        userId: user.userId,
        hasExpiry: Boolean(result.expiresAt),
      });
      deps.clearSsoSignInChallenge?.(context.activity);
      await context.sendActivity(
        "Microsoft Teams delegated auth is connected. Retry the tool now.",
      );
      return true;
    }
    lastFailure = {
      code: result.code,
      status: result.status,
      message: result.message,
    };
  }

  deps.log.error("msteams sso magic-code verification failed", lastFailure);
  await context.sendActivity(
    "That sign-in code could not be verified. Open the latest sign-in link and try the new code.",
  );
  return true;
}

/**
 * Parse and handle feedback invoke activities (thumbs up/down).
 * Returns true if the activity was a feedback invoke, false otherwise.
 */
async function handleFeedbackInvoke(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  const activity = context.activity;
  const value = activity.value as
    | {
        actionName?: string;
        actionValue?: { reaction?: string; feedback?: string };
        replyToId?: string;
      }
    | undefined;

  if (!value) {
    return false;
  }

  // Teams feedback invoke format: actionName="feedback", actionValue.reaction="like"|"dislike"
  if (value.actionName !== "feedback") {
    return false;
  }

  const reaction = value.actionValue?.reaction;
  if (reaction !== "like" && reaction !== "dislike") {
    deps.log.debug?.("ignoring feedback with unknown reaction", { reaction });
    return false;
  }

  const msteamsCfg = deps.cfg.channels?.msteams;
  if (msteamsCfg?.feedbackEnabled === false) {
    deps.log.debug?.("feedback handling disabled");
    return true; // Still consume the invoke
  }

  if (!(await isFeedbackInvokeAuthorized(context, deps))) {
    return true;
  }

  // Extract user comment from the nested JSON string
  let userComment: string | undefined;
  if (value.actionValue?.feedback) {
    try {
      const parsed = JSON.parse(value.actionValue.feedback) as { feedbackText?: string };
      userComment = parsed.feedbackText || undefined;
    } catch {
      // Best effort — feedback text is optional
    }
  }

  // Strip ;messageid=... suffix to match the normalized ID used by the message handler.
  const rawConversationId = activity.conversation?.id ?? "unknown";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
  const messageId = value.replyToId ?? activity.replyToId ?? "unknown";
  const isNegative = reaction === "dislike";

  // Route feedback using the same chat-type logic as normal messages
  // so session keys, agent IDs, and transcript paths match.
  const convType = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
  const isDirectMessage = convType === "personal" || (!convType && !activity.conversation?.isGroup);
  const isChannel = convType === "channel";

  const core = getMSTeamsRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg: deps.cfg,
    channel: "msteams",
    peer: {
      kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      id: isDirectMessage ? senderId : conversationId,
    },
  });

  // Match the thread-aware session key used by the message handler so feedback
  // events land in the correct per-thread transcript. For channel threads, the
  // thread root ID comes from the ;messageid= suffix on the conversation ID or
  // from activity.replyToId.
  const feedbackThreadId = isChannel
    ? (extractMSTeamsConversationMessageId(rawConversationId) ?? activity.replyToId ?? undefined)
    : undefined;
  if (feedbackThreadId) {
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey: route.sessionKey,
      threadId: feedbackThreadId,
      parentSessionKey: route.sessionKey,
    });
    route.sessionKey = threadKeys.sessionKey;
  }

  // Log feedback event to session JSONL
  const feedbackEvent = buildFeedbackEvent({
    messageId,
    value: isNegative ? "negative" : "positive",
    comment: userComment,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    conversationId,
  });

  deps.log.info("received feedback", {
    value: feedbackEvent.value,
    messageId,
    conversationId,
    hasComment: Boolean(userComment),
  });

  // Write feedback event to session transcript
  try {
    const storePath = core.channel.session.resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    const safeKey = route.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const transcriptFile = path.join(storePath, `${safeKey}.jsonl`);
    await appendRegularFile({
      filePath: transcriptFile,
      content: `${JSON.stringify(feedbackEvent)}\n`,
      rejectSymlinkParents: true,
    }).catch(() => {
      // Best effort — transcript dir may not exist yet
    });
  } catch {
    // Best effort
  }

  // Build conversation reference for proactive messages (ack + reflection follow-up)
  const conversationRef = {
    activityId: activity.id,
    user: {
      id: activity.from?.id,
      name: activity.from?.name,
      aadObjectId: activity.from?.aadObjectId,
    },
    agent: activity.recipient
      ? { id: activity.recipient.id, name: activity.recipient.name }
      : undefined,
    bot: activity.recipient
      ? { id: activity.recipient.id, name: activity.recipient.name }
      : undefined,
    conversation: {
      id: conversationId,
      conversationType: activity.conversation?.conversationType,
      tenantId: activity.conversation?.tenantId,
    },
    channelId: activity.channelId ?? "msteams",
    serviceUrl: activity.serviceUrl,
    locale: activity.locale,
  };

  // For negative feedback, trigger background reflection (fire-and-forget).
  // No ack message — the reflection follow-up serves as the acknowledgement.
  // Sending anything during the invoke handler causes "unable to reach app" errors.
  if (isNegative && msteamsCfg?.feedbackReflection !== false) {
    // Note: thumbedDownResponse is not populated here because we don't cache
    // sent message text. The agent still has full session context for reflection
    // since the reflection runs in the same session. The user comment (if any)
    // provides additional signal.
    runFeedbackReflection({
      cfg: deps.cfg,
      adapter: deps.adapter,
      appId: deps.appId,
      conversationRef,
      sessionKey: route.sessionKey,
      agentId: route.agentId,
      conversationId,
      feedbackMessageId: messageId,
      userComment,
      log: deps.log,
    }).catch((err) => {
      deps.log.error("feedback reflection failed", { error: formatUnknownError(err) });
    });
  }

  return true;
}

export function registerMSTeamsHandlers<T extends MSTeamsActivityHandler>(
  handler: T,
  deps: MSTeamsMessageHandlerDeps,
): T {
  const challengeTracker = createSigninChallengeTracker();
  const runtimeDeps: MSTeamsMessageHandlerDeps = {
    ...deps,
    recordSsoSignInChallenge:
      deps.recordSsoSignInChallenge ?? ((activity) => challengeTracker.record(activity)),
    hasSsoSignInChallenge:
      deps.hasSsoSignInChallenge ?? ((activity) => challengeTracker.has(activity)),
    clearSsoSignInChallenge:
      deps.clearSsoSignInChallenge ?? ((activity) => challengeTracker.clear(activity)),
  };
  const handleTeamsMessage = createMSTeamsMessageHandler(runtimeDeps);
  const handleReaction = createMSTeamsReactionHandler(runtimeDeps);

  // Wrap the original run method to intercept invokes
  const originalRun = handler.run;
  if (originalRun) {
    handler.run = async (context: unknown) => {
      const ctx = context as MSTeamsTurnContext;
      // Handle file consent invokes before passing to normal flow
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "fileConsent/invoke") {
        await respondToMSTeamsFileConsentInvoke(ctx, runtimeDeps.log);
        return;
      }

      // Handle feedback invokes (thumbs up/down on AI-generated messages).
      // Just return after handling — the process() handler sends HTTP 200 automatically.
      // Do NOT call sendActivity with invokeResponse; our custom adapter would POST
      // a new activity to Bot Framework instead of responding to the HTTP request.
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "message/submitAction") {
        const handled = await handleFeedbackInvoke(ctx, runtimeDeps);
        if (handled) {
          return;
        }
      }

      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "adaptiveCard/action") {
        const text = serializeAdaptiveCardActionValue(ctx.activity?.value);
        if (text) {
          await handleTeamsMessage({
            ...ctx,
            activity: {
              ...ctx.activity,
              type: "message",
              text,
            },
          });
          return;
        }
        deps.log.debug?.("skipping adaptive card action invoke without value payload");
      }

      if (ctx.activity?.type === "message") {
        const handled = await handleSigninMagicCodeMessage(ctx, runtimeDeps);
        if (handled) {
          return;
        }
      }

      // Bot Framework OAuth SSO: Teams sends signin/tokenExchange (with a
      // Teams-provided exchangeable token) or signin/verifyState (magic
      // code fallback) after an oauthCard is presented. We must ack with
      // HTTP 200 and, if configured, exchange the token with the Bot
      // Framework User Token service and persist it for downstream tools.
      if (
        ctx.activity?.type === "invoke" &&
        (ctx.activity?.name === "signin/tokenExchange" ||
          ctx.activity?.name === "signin/verifyState" ||
          ctx.activity?.name === "signin/failure")
      ) {
        // Always ack immediately — silently dropping the invoke causes
        // the Teams card UI to report "Something went wrong".
        await ctx.sendActivity({ type: "invokeResponse", value: { status: 200, body: {} } });

        if (!(await isSigninInvokeAuthorized(ctx, runtimeDeps))) {
          return;
        }

        if (!runtimeDeps.sso) {
          runtimeDeps.log.debug?.("signin invoke received but msteams.sso is not configured", {
            name: ctx.activity.name,
          });
          return;
        }

        if (ctx.activity.name === "signin/failure") {
          // Teams can emit signin/failure while the browser fallback link is
          // still usable. Keep the pending challenge so a pasted magic code can
          // complete until the normal challenge TTL expires.
          runtimeDeps.log.warn?.(
            "msteams sso signin failure",
            normalizeSigninFailureValue(ctx.activity.value),
          );
          return;
        }

        const users = resolveSigninUserCandidates(ctx.activity);
        if (users.length === 0) {
          runtimeDeps.log.error("msteams sso signin invoke failed", {
            code: "missing_user",
            status: undefined,
            message: "no user id on invoke activity",
          });
          return;
        }

        try {
          if (ctx.activity.name === "signin/tokenExchange") {
            const parsed = parseSigninTokenExchangeValue(ctx.activity.value);
            if (!parsed) {
              deps.log.debug?.("invalid signin/tokenExchange invoke value");
              return;
            }
            let lastFailure:
              | {
                  code: string;
                  status?: number;
                  message: string;
                }
              | undefined;
            for (const user of users) {
              const result = await handleSigninTokenExchangeInvoke({
                value: parsed,
                user,
                deps: runtimeDeps.sso,
              });
              if (result.ok) {
                runtimeDeps.clearSsoSignInChallenge?.(ctx.activity);
                runtimeDeps.log.info("msteams sso token exchanged", {
                  userId: user.userId,
                  hasExpiry: Boolean(result.expiresAt),
                });
                return;
              }
              lastFailure = {
                code: result.code,
                status: result.status,
                message: result.message,
              };
            }
            runtimeDeps.log.error("msteams sso token exchange failed", lastFailure);
            return;
          }

          // signin/verifyState
          const parsed = parseSigninVerifyStateValue(ctx.activity.value);
          if (!parsed) {
            deps.log.debug?.("invalid signin/verifyState invoke value");
            return;
          }
          let lastFailure:
            | {
                code: string;
                status?: number;
                message: string;
              }
            | undefined;
          for (const user of users) {
            const result = await handleSigninVerifyStateInvoke({
              value: parsed,
              user,
              deps: runtimeDeps.sso,
            });
            if (result.ok) {
              runtimeDeps.clearSsoSignInChallenge?.(ctx.activity);
              runtimeDeps.log.info("msteams sso verifyState succeeded", {
                userId: user.userId,
                hasExpiry: Boolean(result.expiresAt),
              });
              return;
            }
            lastFailure = {
              code: result.code,
              status: result.status,
              message: result.message,
            };
          }
          runtimeDeps.log.error("msteams sso verifyState failed", lastFailure);
        } catch (err) {
          runtimeDeps.log.error("msteams sso invoke handler error", {
            error: formatUnknownError(err),
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

  return handler;
}
