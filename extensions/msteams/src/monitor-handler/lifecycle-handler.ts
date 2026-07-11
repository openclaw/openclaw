// Msteams plugin module handles app lifecycle session boundaries.
import { randomUUID } from "node:crypto";
import {
  listSessionEntries,
  patchSessionEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeStoredConversationId,
  parseStoredConversationTimestamp,
} from "../conversation-store-helpers.js";
import { formatUnknownError } from "../errors.js";
import { normalizeMSTeamsConversationId } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

type LifecycleResetReason =
  | "installation-add-existing"
  | "installation-remove"
  | "bot-members-removed";

export type MSTeamsLifecycleResetResult = {
  handled: boolean;
  reason?: LifecycleResetReason;
  conversationRemoved: boolean;
  sessionsReset: number;
};

export type MSTeamsDmConversationBoundaryResult = {
  handled: boolean;
  previousConversationRemoved: boolean;
  sessionsReset: number;
};

const REMOVE_INSTALLATION_ACTIONS = new Set(["remove", "remove-upgrade"]);

function getConversationType(context: MSTeamsTurnContext): "personal" | "channel" | "group" {
  const normalized =
    normalizeOptionalLowercaseString(context.activity?.conversation?.conversationType) ??
    "personal";
  if (normalized === "channel") {
    return "channel";
  }
  if (normalized === "groupchat") {
    return "group";
  }
  return "personal";
}

function getSenderId(context: MSTeamsTurnContext): string {
  return (
    normalizeOptionalLowercaseString(context.activity?.from?.aadObjectId) ??
    normalizeOptionalLowercaseString(context.activity?.from?.id) ??
    ""
  );
}

function getTeamId(context: MSTeamsTurnContext): string | undefined {
  return context.activity?.channelData?.team?.id ?? context.activity?.conversation?.tenantId;
}

function isRemoveInstallationUpdate(context: MSTeamsTurnContext): boolean {
  if (context.activity?.type !== "installationUpdate") {
    return false;
  }
  const action = normalizeOptionalLowercaseString(context.activity?.action);
  return action ? REMOVE_INSTALLATION_ACTIONS.has(action) : false;
}

function isAddInstallationUpdate(context: MSTeamsTurnContext): boolean {
  if (context.activity?.type !== "installationUpdate") {
    return false;
  }
  return normalizeOptionalLowercaseString(context.activity?.action) === "add";
}

function isBotRemovedFromConversation(context: MSTeamsTurnContext): boolean {
  if (context.activity?.type !== "conversationUpdate") {
    return false;
  }
  const botId = normalizeOptionalLowercaseString(context.activity?.recipient?.id);
  if (!botId) {
    return false;
  }
  return (context.activity?.membersRemoved ?? []).some(
    (member) => normalizeOptionalLowercaseString(member.id) === botId,
  );
}

function matchesSessionKey(params: {
  sessionKey: string;
  routeSessionKey: string;
  includeChannelThreads: boolean;
}): boolean {
  const sessionKey = params.sessionKey.toLowerCase();
  const routeSessionKey = params.routeSessionKey.toLowerCase();
  return (
    sessionKey === routeSessionKey ||
    (params.includeChannelThreads && sessionKey.startsWith(`${routeSessionKey}:thread:`))
  );
}

type MSTeamsResetCandidateEntry = {
  updatedAt?: number;
  route?: unknown;
  deliveryContext?: unknown;
  lastChannel?: unknown;
  lastTo?: unknown;
  lastAccountId?: unknown;
  origin?: unknown;
};

function hasMSTeamsProviderBinding(entry: MSTeamsResetCandidateEntry): boolean {
  return Boolean(
    entry.route ||
    entry.deliveryContext ||
    entry.lastChannel ||
    entry.lastTo ||
    entry.lastAccountId ||
    entry.origin,
  );
}

function needsMSTeamsLifecycleRotation(entry: MSTeamsResetCandidateEntry): boolean {
  // Discord-style stale markers only set updatedAt to 0. Teams lifecycle resets
  // also need to clear provider binding metadata that can survive older resets.
  return entry.updatedAt !== 0 || hasMSTeamsProviderBinding(entry);
}

export async function rotateMSTeamsSessions(params: {
  deps: MSTeamsMessageHandlerDeps;
  routeSessionKey: string;
  agentId: string;
  includeChannelThreads: boolean;
}): Promise<number> {
  const storePath = resolveStorePath(params.deps.cfg.session?.store, {
    agentId: params.agentId,
  });

  let resetCount = 0;

  for (const { sessionKey, entry } of listSessionEntries({ storePath })) {
    if (
      !matchesSessionKey({
        sessionKey,
        routeSessionKey: params.routeSessionKey,
        includeChannelThreads: params.includeChannelThreads,
      }) ||
      !needsMSTeamsLifecycleRotation(entry)
    ) {
      continue;
    }

    let resetEntry = false;
    await patchSessionEntry({
      storePath,
      sessionKey,
      replaceEntry: true,
      update: (current) => {
        if (current.updatedAt !== entry.updatedAt || current.sessionId !== entry.sessionId) {
          return null;
        }
        if (!needsMSTeamsLifecycleRotation(current)) {
          return null;
        }
        resetEntry = true;
        return {
          sessionId: randomUUID(),
          updatedAt: 0,
        };
      },
    });
    if (resetEntry) {
      resetCount += 1;
    }
  }

  return resetCount;
}

function isSameTeamsUser(params: {
  senderId: string;
  user?: { id?: string; aadObjectId?: string };
}): boolean {
  const senderId = normalizeOptionalLowercaseString(params.senderId);
  if (!senderId) {
    return false;
  }
  return (
    normalizeOptionalLowercaseString(params.user?.aadObjectId) === senderId ||
    normalizeOptionalLowercaseString(params.user?.id) === senderId
  );
}

function isSameTeamsBot(params: {
  botId?: string;
  agent?: { id?: string } | null;
  bot?: { id?: string } | null;
}): boolean {
  const botId = normalizeOptionalLowercaseString(params.botId);
  if (!botId) {
    return true;
  }
  const storedBotId =
    normalizeOptionalLowercaseString(params.agent?.id) ??
    normalizeOptionalLowercaseString(params.bot?.id);
  return !storedBotId || storedBotId === botId;
}

function isStoredPersonalConversation(conversationType?: string): boolean {
  const normalized = normalizeOptionalLowercaseString(conversationType ?? "");
  return !normalized || normalized === "personal";
}

async function findStoredPersonalDmConversation(params: {
  deps: MSTeamsMessageHandlerDeps;
  senderId: string;
  botId?: string;
}) {
  const matches = (await params.deps.conversationStore.list()).filter((entry) => {
    const reference = entry.reference;
    return (
      isStoredPersonalConversation(reference.conversation?.conversationType) &&
      isSameTeamsUser({ senderId: params.senderId, user: reference.user }) &&
      isSameTeamsBot({ botId: params.botId, agent: reference.agent, bot: reference.bot }) &&
      Boolean(reference.conversation?.id ?? entry.conversationId)
    );
  });
  matches.sort(
    (a, b) =>
      (parseStoredConversationTimestamp(b.reference.lastSeenAt) ?? 0) -
      (parseStoredConversationTimestamp(a.reference.lastSeenAt) ?? 0),
  );
  return matches[0] ?? null;
}

export async function handleMSTeamsDmConversationBoundary(params: {
  deps: MSTeamsMessageHandlerDeps;
  conversationId: string;
  senderId: string;
  botId?: string;
  routeSessionKey: string;
  agentId: string;
}): Promise<MSTeamsDmConversationBoundaryResult> {
  const conversationId = normalizeStoredConversationId(params.conversationId);
  if (!conversationId || !params.senderId) {
    return { handled: false, previousConversationRemoved: false, sessionsReset: 0 };
  }

  let previous;
  try {
    previous = await findStoredPersonalDmConversation({
      deps: params.deps,
      senderId: params.senderId,
      botId: params.botId,
    });
  } catch (err) {
    params.deps.log.debug?.("failed to inspect msteams dm conversation boundary", {
      error: formatUnknownError(err),
    });
    return { handled: false, previousConversationRemoved: false, sessionsReset: 0 };
  }

  const previousConversationId = previous
    ? normalizeStoredConversationId(previous.reference.conversation?.id ?? previous.conversationId)
    : "";
  if (!previousConversationId || previousConversationId === conversationId) {
    return { handled: false, previousConversationRemoved: false, sessionsReset: 0 };
  }

  let previousConversationRemoved = false;
  try {
    previousConversationRemoved =
      await params.deps.conversationStore.remove(previousConversationId);
  } catch (err) {
    params.deps.log.debug?.("failed to remove previous msteams dm conversation reference", {
      error: formatUnknownError(err),
    });
  }

  const sessionsReset = await rotateMSTeamsSessions({
    deps: params.deps,
    routeSessionKey: params.routeSessionKey,
    agentId: params.agentId,
    includeChannelThreads: false,
  });

  params.deps.log.info("msteams dm conversation boundary handled", {
    previousConversationRemoved,
    sessionsReset,
  });

  return { handled: true, previousConversationRemoved, sessionsReset };
}

export async function handleMSTeamsLifecycleRemove(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<MSTeamsLifecycleResetResult> {
  const isInstallAdd = isAddInstallationUpdate(context);
  const reason: LifecycleResetReason | undefined = isRemoveInstallationUpdate(context)
    ? "installation-remove"
    : isInstallAdd
      ? "installation-add-existing"
      : isBotRemovedFromConversation(context)
        ? "bot-members-removed"
        : undefined;
  if (!reason) {
    return { handled: false, conversationRemoved: false, sessionsReset: 0 };
  }

  const rawConversationId = context.activity?.conversation?.id ?? "";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  if (!conversationId) {
    deps.log.debug?.("msteams lifecycle remove ignored (missing conversation id)", { reason });
    return { handled: true, reason, conversationRemoved: false, sessionsReset: 0 };
  }

  const conversationType = getConversationType(context);
  if (isInstallAdd && conversationType !== "personal") {
    return { handled: false, reason, conversationRemoved: false, sessionsReset: 0 };
  }

  let conversationRemoved = false;
  if (!isInstallAdd) {
    try {
      conversationRemoved = await deps.conversationStore.remove(conversationId);
    } catch (err) {
      deps.log.debug?.("failed to remove msteams conversation reference", {
        reason,
        error: formatUnknownError(err),
      });
    }
  }

  const senderId = getSenderId(context);
  if (conversationType === "personal" && !senderId) {
    deps.log.debug?.("msteams lifecycle remove skipped session reset (missing sender)", {
      reason,
      conversationType,
      conversationRemoved,
    });
    return { handled: true, reason, conversationRemoved, sessionsReset: 0 };
  }

  const core = getMSTeamsRuntime();
  const peer =
    conversationType === "personal"
      ? { kind: "direct" as const, id: senderId }
      : conversationType === "channel"
        ? { kind: "channel" as const, id: conversationId }
        : { kind: "group" as const, id: conversationId };
  const route = core.channel.routing.resolveAgentRoute({
    cfg: deps.cfg,
    channel: "msteams",
    teamId: getTeamId(context),
    peer,
  });

  const sessionsReset = await rotateMSTeamsSessions({
    deps,
    routeSessionKey: route.sessionKey,
    agentId: route.agentId,
    includeChannelThreads: conversationType === "channel",
  });

  if (isInstallAdd && sessionsReset === 0) {
    return { handled: false, reason, conversationRemoved, sessionsReset };
  }

  deps.log.info("msteams lifecycle remove handled", {
    reason,
    conversationType,
    conversationRemoved,
    sessionsReset,
  });

  return { handled: true, reason, conversationRemoved, sessionsReset };
}
