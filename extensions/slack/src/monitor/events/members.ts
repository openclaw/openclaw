import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { getOptionalSlackRuntime } from "../../runtime.js";
import { allowListMatches } from "../allow-list.js";
import { resolveSlackEffectiveAllowFrom } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMemberChannelEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

const pendingAutoApprovedChannels = new Set<string>();

function normalizeSlackId(raw?: string | null): string {
  return (raw ?? "").trim().toLowerCase();
}

function isSlackRoomChannel(channelId?: string | null): boolean {
  return /^[cg][a-z0-9]+$/i.test((channelId ?? "").trim());
}

function resolveSlackChannelConfigWriteTarget(params: {
  draft: Record<string, unknown>;
  accountId: string;
}) {
  const channels = (params.draft.channels ??= {}) as Record<string, unknown>;
  const slack = (channels.slack ??= {}) as Record<string, unknown>;
  const accountId = params.accountId.trim() || "default";
  const accounts = slack.accounts;
  const shouldUseAccount =
    accountId !== "default" || (accounts !== null && typeof accounts === "object");

  if (!shouldUseAccount) {
    const channelEntries = (slack.channels ??= {}) as Record<string, unknown>;
    return channelEntries;
  }

  const accountEntries = (slack.accounts ??= {}) as Record<string, unknown>;
  const account = (accountEntries[accountId] ??= {}) as Record<string, unknown>;
  return (account.channels ??= {}) as Record<string, unknown>;
}

async function maybeAutoApproveBotChannelJoin(params: {
  ctx: SlackMonitorContext;
  event: SlackMemberChannelEvent;
}): Promise<boolean> {
  const { ctx, event } = params;
  if (event.type !== "member_joined_channel") {
    return false;
  }
  const channelId = event.channel?.trim();
  if (!channelId || !isSlackRoomChannel(channelId)) {
    return false;
  }
  if (normalizeSlackId(event.user) !== normalizeSlackId(ctx.botUserId)) {
    return false;
  }
  const inviterId = event.inviter?.trim();
  if (!inviterId) {
    logVerbose(`slack: bot joined ${channelId} without inviter; channel auto-approval skipped`);
    return false;
  }

  const allowFrom = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: false });
  if (allowFrom.length === 0) {
    logVerbose(
      `slack: bot invited to ${channelId} by ${inviterId}; no allowFrom entries configured for channel auto-approval`,
    );
    return false;
  }
  const inviterInfo: { name?: string } = await ctx.resolveUserName(inviterId).catch(() => ({}));
  if (
    !allowListMatches({
      allowList: allowFrom,
      id: inviterId,
      name: inviterInfo.name,
      allowNameMatching: ctx.allowNameMatching,
    })
  ) {
    logVerbose(
      `slack: bot invited to ${channelId} by non-allowlisted user ${inviterId}; channel auto-approval skipped`,
    );
    return false;
  }

  if (ctx.channelsConfig?.[channelId]) {
    return true;
  }

  const pendingKey = `${ctx.accountId}:${channelId}`;
  if (pendingAutoApprovedChannels.has(pendingKey)) {
    return true;
  }
  pendingAutoApprovedChannels.add(pendingKey);
  try {
    const runtime = getOptionalSlackRuntime();
    if (!runtime?.config?.mutateConfigFile) {
      ctx.runtime.error?.(
        danger(`slack channel auto-approval skipped for ${channelId}: runtime config unavailable`),
      );
      return false;
    }
    const channelEntry = {
      enabled: true,
      requireMention: ctx.defaultRequireMention,
    };
    await runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const target = resolveSlackChannelConfigWriteTarget({
          draft: draft as Record<string, unknown>,
          accountId: ctx.accountId,
        });
        target[channelId] = {
          ...((target[channelId] && typeof target[channelId] === "object"
            ? target[channelId]
            : {}) as Record<string, unknown>),
          ...channelEntry,
        };
      },
    });
    ctx.channelsConfig = {
      ...(ctx.channelsConfig ?? {}),
      [channelId]: {
        ...(ctx.channelsConfig?.[channelId] ?? {}),
        ...channelEntry,
      },
    };
    ctx.channelsConfigKeys = Object.keys(ctx.channelsConfig);
    ctx.runtime.log?.(
      `slack: auto-approved channel ${channelId} after OpenClaw was invited by allowlisted user ${inviterId}`,
    );
    return true;
  } catch (err) {
    ctx.runtime.error?.(
      danger(`slack channel auto-approval failed for ${channelId}: ${formatErrorMessage(err)}`),
    );
    return false;
  } finally {
    pendingAutoApprovedChannels.delete(pendingKey);
  }
}

export function registerSlackMemberEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const handleMemberChannelEvent = async (params: {
    verb: "joined" | "left";
    event: SlackMemberChannelEvent;
    body: unknown;
  }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(params.body)) {
        return;
      }
      trackEvent?.();
      const payload = params.event;
      const channelId = payload.channel;
      const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
      const channelType = payload.channel_type ?? channelInfo?.type;
      await maybeAutoApproveBotChannelJoin({ ctx, event: payload });
      const senderId =
        params.verb === "joined" &&
        normalizeSlackId(payload.user) === normalizeSlackId(ctx.botUserId) &&
        payload.inviter
          ? payload.inviter
          : payload.user;
      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId,
        channelId,
        channelType,
        eventKind: `member-${params.verb}`,
      });
      if (!ingressContext) {
        return;
      }
      const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
      const userLabel = userInfo?.name ?? payload.user ?? "someone";
      enqueueSystemEvent(`Slack: ${userLabel} ${params.verb} ${ingressContext.channelLabel}.`, {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:member:${params.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
      });
    } catch (err) {
      ctx.runtime.error?.(
        danger(`slack ${params.verb} handler failed: ${formatErrorMessage(err)}`),
      );
    }
  };

  ctx.app.event(
    "member_joined_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_joined_channel">) => {
      await handleMemberChannelEvent({
        verb: "joined",
        event: event as SlackMemberChannelEvent,
        body,
      });
    },
  );

  ctx.app.event(
    "member_left_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_left_channel">) => {
      await handleMemberChannelEvent({
        verb: "left",
        event: event as SlackMemberChannelEvent,
        body,
      });
    },
  );
}
