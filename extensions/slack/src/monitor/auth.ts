import {
  type ChannelIngressDecision,
  type ChannelIngressEventInput,
  type ChannelIngressContextBinding,
  type ChannelIngressPolicyInput,
  type ChannelIngressStateInput,
  readChannelIngressStoreAllowFromForDmPolicy,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeStringEntriesLower } from "openclaw/plugin-sdk/string-normalization-runtime";
import { collectSlackCursorPages } from "../cursor-pages.js";
import { getSlackRuntime } from "../runtime.js";
import type { SlackMessageEvent } from "../types.js";
import {
  allowListMatches,
  normalizeSlackAllowOwnerEntry,
  resolveSlackUserAllowListForTeam,
} from "./allow-list.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import {
  inferSlackChannelType,
  normalizeSlackChannelType,
  parseSlackChannelType,
  resolveSlackChatType,
} from "./channel-type.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";
import {
  createSlackIngressSubject,
  slackIngressIdentity,
  SLACK_USER_NAME_KIND,
} from "./ingress-identity.js";
import { getOrCreateWeakOwnerMap } from "./lru-map-cache.js";
import { isTransientSlackApiError } from "./transient-api-error.js";

type SlackChannelMembersCacheEntry = {
  expiresAtMs: number;
  members?: Set<string>;
  pending?: Promise<Set<string>>;
};

type SlackIngressChannelType = NonNullable<SlackMessageEvent["channel_type"]>;
type SlackSystemEventAuthorization = ({ allowed: true } | { allowed: false; reason: string }) &
  Partial<{ channelType: SlackIngressChannelType; channelName: string }>;

const slackChannelMembersCache = new WeakMap<
  SlackMonitorContext,
  Map<string, SlackChannelMembersCacheEntry>
>();
const CHANNEL_MEMBERS_CACHE_TTL_MS = 60_000;
const CHANNEL_MEMBERS_CACHE_MAX = 512;
const SLACK_CHANNEL_ID = "slack";
export class SlackSystemEventAuthRetryError extends Error {}

function createSlackIngressResolver(ctx: SlackMonitorContext) {
  return getSlackRuntime().channel.inbound.ingress.createResolver({
    channelId: SLACK_CHANNEL_ID,
    accountId: ctx.accountId,
    identity: slackIngressIdentity,
    cfg: ctx.cfg,
  });
}

export async function resolveSlackEffectiveAllowFrom(
  ctx: SlackMonitorContext,
  options?: { includePairingStore?: boolean; eventScope?: SlackEventScope },
) {
  const teamId = options?.eventScope?.teamId ?? ctx.teamId;
  const base = resolveSlackUserAllowListForTeam({ allowList: ctx.allowFrom, teamId });
  if (options?.includePairingStore !== true) {
    return base;
  }
  const storeAllowFrom = await readChannelIngressStoreAllowFromForDmPolicy({
    provider: "slack",
    accountId: ctx.accountId,
    dmPolicy: ctx.dmPolicy,
  });
  return resolveSlackUserAllowListForTeam({
    allowList: [...base, ...storeAllowFrom],
    teamId,
  });
}

async function fetchSlackChannelMemberIds(
  ctx: SlackMonitorContext,
  channelId: string,
  eventScope?: SlackEventScope,
): Promise<Set<string>> {
  const members = await collectSlackCursorPages({
    fetchPage: (cursor) =>
      (eventScope?.client ?? ctx.app.client).conversations.members({
        token: ctx.botToken,
        channel: channelId,
        limit: 999,
        ...(cursor ? { cursor } : {}),
      }),
    collectPageItems: (response) => normalizeStringEntriesLower(response.members),
  });
  return new Set(members);
}

async function resolveSlackChannelMemberIds(
  ctx: SlackMonitorContext,
  channelId: string,
  eventScope?: SlackEventScope,
): Promise<Set<string>> {
  const cache = getOrCreateWeakOwnerMap(slackChannelMembersCache, ctx);
  const key = `${ctx.accountId}:${eventScope ? `${eventScope.teamId}:` : ""}${channelId}`;
  const nowMs = Date.now();
  const cached = cache.get(key);
  if (cached?.members) {
    if (cached.expiresAtMs >= nowMs) {
      return cached.members;
    }
    cache.delete(key);
  }
  if (cached?.pending) {
    return await cached.pending;
  }

  const pending = fetchSlackChannelMemberIds(ctx, channelId, eventScope);
  cache.set(key, {
    expiresAtMs: nowMs + CHANNEL_MEMBERS_CACHE_TTL_MS,
    pending,
  });
  pruneMapToMaxSize(cache, CHANNEL_MEMBERS_CACHE_MAX);
  try {
    const members = await pending;
    cache.set(key, {
      expiresAtMs: Date.now() + CHANNEL_MEMBERS_CACHE_TTL_MS,
      members,
    });
    pruneMapToMaxSize(cache, CHANNEL_MEMBERS_CACHE_MAX);
    return members;
  } finally {
    const latest = cache.get(key);
    if (latest?.pending === pending) {
      cache.delete(key);
    }
  }
}

function resolveExplicitSlackOwnerIds(allowFromLower: string[]): string[] {
  const ownerIds = new Set<string>();
  for (const entry of allowFromLower) {
    const ownerId = normalizeSlackAllowOwnerEntry(entry);
    if (ownerId) {
      ownerIds.add(ownerId);
    }
  }
  return [...ownerIds];
}

export async function authorizeSlackBotRoomMessage(params: {
  ctx: SlackMonitorContext;
  channelId: string;
  senderId: string;
  senderName?: string;
  channelUsers?: Array<string | number>;
  allowFromLower: string[];
  eventScope?: SlackEventScope;
}): Promise<boolean> {
  const channelUserAllowList = normalizeStringEntriesLower(params.channelUsers).filter(
    (entry) => entry !== "*",
  );
  if (
    channelUserAllowList.length > 0 &&
    allowListMatches({
      allowList: channelUserAllowList,
      teamId: params.eventScope?.teamId ?? params.ctx.teamId,
      id: params.senderId,
      name: params.senderName,
      allowNameMatching: params.ctx.allowNameMatching,
    })
  ) {
    return true;
  }

  const explicitOwnerIds = resolveExplicitSlackOwnerIds(params.allowFromLower);
  if (explicitOwnerIds.length === 0) {
    logVerbose(
      `slack: drop bot message ${params.senderId} in ${params.channelId} (no explicit owner id for presence check)`,
    );
    return false;
  }

  try {
    const channelMemberIds = await resolveSlackChannelMemberIds(
      params.ctx,
      params.channelId,
      params.eventScope,
    );
    if (explicitOwnerIds.some((ownerId) => channelMemberIds.has(ownerId))) {
      return true;
    }
    logVerbose(
      `slack: drop bot message ${params.senderId} in ${params.channelId} (no owner present)`,
    );
  } catch (error) {
    logVerbose(
      `slack: drop bot message ${params.senderId} in ${params.channelId} (owner presence lookup failed: ${formatErrorMessage(error)})`,
    );
  }
  return false;
}

function wildcardWhenOpen(entries: readonly string[]): string[] {
  return entries.length > 0 ? [...entries] : ["*"];
}

export async function resolveSlackCommandIngress(params: {
  ctx: SlackMonitorContext;
  teamId?: string;
  senderId: string;
  senderAuthentication?: "verified" | "asserted";
  senderName?: string;
  channelType: SlackIngressChannelType;
  channelId: string;
  threadId?: string;
  ownerAllowFromLower: string[];
  channelUsers?: Array<string | number>;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  mentionFacts?: ChannelIngressStateInput["mentionFacts"];
  activation?: NonNullable<ChannelIngressPolicyInput["activation"]>;
  eventKind?: ChannelIngressEventInput["kind"];
  modeWhenAccessGroupsOff?: NonNullable<
    ChannelIngressPolicyInput["command"]
  >["modeWhenAccessGroupsOff"];
  contextBinding?: ChannelIngressContextBinding;
}) {
  const isDirectMessage = params.channelType === "im";
  const isGroupDm = params.channelType === "mpim";
  const teamId = params.teamId ?? params.ctx.teamId;
  const ownerAllowFrom = resolveSlackUserAllowListForTeam({
    allowList: params.ownerAllowFromLower,
    teamId,
  });
  const channelUsers = resolveSlackUserAllowListForTeam({
    allowList: params.channelUsers,
    teamId,
  });
  const channelUsersConfigured =
    !isDirectMessage && !isGroupDm && normalizeStringEntriesLower(params.channelUsers).length > 0;
  // MPIM ingress is group-shaped, but its sender policy is DM-owned. Callers
  // pass configured allowFrom without pairing-store approvals for this path.
  const groupAllowFrom = isGroupDm ? ownerAllowFrom : channelUsersConfigured ? channelUsers : [];
  return await createSlackIngressResolver(params.ctx).message({
    subject: createSlackIngressSubject({
      senderId: params.senderId,
      senderAuthentication: params.senderAuthentication,
      senderName: params.senderName,
      teamId,
    }),
    conversation: {
      kind: resolveSlackChatType(params.channelType),
      id: params.channelId,
      threadId: params.threadId,
    },
    contextBinding: params.contextBinding,
    event: {
      kind: params.eventKind ?? "message",
      authMode: "inbound",
      mayPair: false,
    },
    dmPolicy: isDirectMessage ? "open" : "disabled",
    groupPolicy: isGroupDm || channelUsersConfigured ? "allowlist" : "open",
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      mutableIdentifierMatching: params.ctx.allowNameMatching ? "enabled" : "disabled",
      ...(params.activation ? { activation: params.activation } : {}),
    },
    mentionFacts: params.mentionFacts,
    allowFrom: isDirectMessage ? ["*"] : ownerAllowFrom,
    groupAllowFrom,
    command: {
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
      ...(isDirectMessage ? { commandOwnerAllowFrom: ownerAllowFrom } : {}),
    },
  });
}

export async function authorizeSlackSystemEventSender(params: {
  ctx: SlackMonitorContext;
  senderId?: string;
  channelId?: string;
  channelType?: string | null;
  eventScope?: SlackEventScope;
  expectedSenderId?: string;
  retryNameLookup?: boolean;
  /** When true, requires expectedSenderId, rejects ambiguous channel types,
   *  and applies interactive-only owner allowFrom checks without changing the
   *  open-by-default channel behavior when no allowlists are configured. */
  interactiveEvent?: boolean;
}): Promise<SlackSystemEventAuthorization> {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return { allowed: false, reason: "missing-sender" };
  }

  const expectedSenderId = params.expectedSenderId?.trim();
  if (expectedSenderId && expectedSenderId !== senderId) {
    return { allowed: false, reason: "sender-mismatch" };
  }

  // Interactive events require an expected sender to cross-verify the actor.
  if (params.interactiveEvent && !expectedSenderId) {
    return { allowed: false, reason: "missing-expected-sender" };
  }

  const channelId = params.channelId?.trim();
  let channelType = normalizeSlackChannelType(params.channelType, channelId);
  let channelName: string | undefined;
  if (channelId) {
    const info: {
      name?: string;
      type?: NonNullable<SlackMessageEvent["channel_type"]>;
    } = await params.ctx.resolveChannelName(channelId, params.eventScope).catch(() => ({}));
    channelName = info.name;
    const resolvedTypeSource = params.channelType ?? info.type;
    channelType = normalizeSlackChannelType(resolvedTypeSource, channelId);
    if (
      !params.ctx.isChannelAllowed({
        teamId: params.eventScope?.teamId ?? params.ctx.teamId,
        channelId,
        channelName,
        channelType,
      })
    ) {
      return {
        allowed: false,
        reason: "channel-not-allowed",
        channelType,
        channelName,
      };
    }

    // For interactive events, reject when channel type could not be positively
    // determined from either the explicit type or the channel ID prefix. This
    // prevents a DM from being misclassified as "channel" and skipping
    // DM-specific authorization.
    if (params.interactiveEvent) {
      const inferredFromId = inferSlackChannelType(channelId);
      if (inferredFromId === undefined && !parseSlackChannelType(resolvedTypeSource)) {
        return {
          allowed: false,
          reason: "ambiguous-channel-type",
          channelType,
          channelName,
        };
      }
    }
  }

  const senderInfo = params.retryNameLookup
    ? undefined
    : await params.ctx.resolveUserName(senderId, params.eventScope);
  const ingressChannelType = channelType ?? "channel";

  if (ingressChannelType === "im") {
    if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") {
      return { allowed: false, reason: "dm-disabled", channelType, channelName };
    }
  }

  const allowFromLower = await resolveSlackEffectiveAllowFrom(params.ctx, {
    includePairingStore: ingressChannelType === "im",
    eventScope: params.eventScope,
  });
  const channelConfig = channelId
    ? resolveSlackChannelConfig({
        teamId: params.eventScope?.teamId ?? params.ctx.teamId,
        allowUnscoped: params.ctx.installationIdentity?.kind !== "enterprise",
        channelId,
        channelName,
        channels: params.ctx.channelsConfig,
        channelKeys: params.ctx.channelsConfigKeys,
        defaultRequireMention: params.ctx.defaultRequireMention,
        allowNameMatching: params.ctx.allowNameMatching,
      })
    : null;
  const channelUsersAllowlistConfigured = (channelConfig?.users?.length ?? 0) > 0;
  const decision = await (async (): Promise<ChannelIngressDecision> => {
    const systemInteractiveEvent = params.interactiveEvent === true;
    const systemRetryNameLookup = params.retryNameLookup && params.ctx.allowNameMatching;
    const isDirectMessage = ingressChannelType === "im";
    const isGroupDm = ingressChannelType === "mpim";
    const teamId = params.eventScope?.teamId ?? params.ctx.teamId;
    const normalizedOwnerAllowFromLower = resolveSlackUserAllowListForTeam({
      allowList: allowFromLower,
      teamId,
    });
    const normalizedChannelUsers = resolveSlackUserAllowListForTeam({
      allowList: channelConfig?.users,
      teamId,
    });
    const normalizedChannelUsersConfigured =
      !isDirectMessage &&
      !isGroupDm &&
      normalizeStringEntriesLower(channelConfig?.users).length > 0;
    const ownerAllowFrom =
      systemInteractiveEvent && normalizedChannelUsersConfigured
        ? normalizedOwnerAllowFromLower.filter((entry) => entry !== "*")
        : normalizedOwnerAllowFromLower;
    const hasAnyCommandAllowlist = ownerAllowFrom.length > 0 || normalizedChannelUsersConfigured;
    const groupAllowFrom = (() => {
      if (isDirectMessage) {
        return [];
      }
      if (isGroupDm) {
        return ownerAllowFrom;
      }
      if (systemInteractiveEvent && hasAnyCommandAllowlist) {
        return normalizedChannelUsersConfigured ? normalizedChannelUsers : [];
      }
      if (normalizedChannelUsersConfigured) {
        return normalizedChannelUsers;
      }
      return channelId ? ["*"] : wildcardWhenOpen(normalizedOwnerAllowFromLower);
    })();
    const subject = (senderName?: string) =>
      createSlackIngressSubject({
        senderId,
        senderName,
        teamId,
      });
    const resolver = createSlackIngressResolver(params.ctx);
    const input: Parameters<typeof resolver.message>[0] = {
      subject: subject(senderInfo?.name),
      conversation: {
        kind: resolveSlackChatType(ingressChannelType),
        id: channelId ?? "slack-system",
      },
      event: {
        kind: systemInteractiveEvent ? "button" : "system",
        authMode: systemInteractiveEvent && hasAnyCommandAllowlist ? "command" : "inbound",
        mayPair: false,
      },
      dmPolicy: isDirectMessage ? "open" : "disabled",
      groupPolicy: isGroupDm
        ? "allowlist"
        : systemInteractiveEvent && hasAnyCommandAllowlist
          ? "open"
          : normalizedChannelUsersConfigured ||
              (!channelId && normalizedOwnerAllowFromLower.length > 0)
            ? "allowlist"
            : "open",
      policy: {
        groupAllowFromFallbackToAllowFrom: false,
        mutableIdentifierMatching: params.ctx.allowNameMatching ? "enabled" : "disabled",
      },
      allowFrom: isDirectMessage ? wildcardWhenOpen(normalizedOwnerAllowFromLower) : ownerAllowFrom,
      groupAllowFrom,
      command:
        systemInteractiveEvent && hasAnyCommandAllowlist
          ? {
              useAccessGroups: true,
              allowTextCommands: true,
              modeWhenAccessGroupsOff: "configured",
              commandOwnerAllowFrom: ownerAllowFrom,
            }
          : undefined,
    };
    const result = await resolver.message(input);
    if (
      result.ingress.decision !== "allow" &&
      systemRetryNameLookup &&
      result.state.allowlists[isDirectMessage ? "dm" : "group"].normalizedEntries.some(
        (entry) => entry.kind === SLACK_USER_NAME_KIND,
      )
    ) {
      const lookup = await params.ctx.resolveUserName(senderId, params.eventScope);
      if (lookup.error && isTransientSlackApiError(lookup.error)) {
        throw new SlackSystemEventAuthRetryError(formatErrorMessage(lookup.error));
      }
      if (lookup.name) {
        return (await resolver.message({ ...input, subject: subject(lookup.name) })).ingress;
      }
    }
    return result.ingress;
  })();
  if (decision.decision === "allow") {
    return {
      allowed: true,
      channelType,
      channelName,
    };
  }
  if (channelType === "im" || !channelId) {
    return {
      allowed: false,
      reason: "sender-not-allowlisted",
      ...(channelId ? { channelType, channelName } : {}),
    };
  }
  return {
    allowed: false,
    reason:
      params.interactiveEvent && channelUsersAllowlistConfigured && allowFromLower.length > 0
        ? "sender-not-authorized"
        : channelUsersAllowlistConfigured
          ? "sender-not-channel-allowed"
          : "sender-not-allowlisted",
    channelType,
    channelName,
  };
}
