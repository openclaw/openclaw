// Msteams plugin module handles app lifecycle session boundaries.
import {
  listSessionEntries,
  patchSessionEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatUnknownError } from "../errors.js";
import { normalizeMSTeamsConversationId } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

type LifecycleResetReason = "installation-remove" | "bot-members-removed";

export type MSTeamsLifecycleResetResult = {
  handled: boolean;
  reason?: LifecycleResetReason;
  conversationRemoved: boolean;
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

async function markMSTeamsSessionsStale(params: {
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
      entry.updatedAt === 0
    ) {
      continue;
    }

    let resetEntry = false;
    await patchSessionEntry({
      storePath,
      sessionKey,
      replaceEntry: true,
      update: (current) => {
        if (current.updatedAt === 0) {
          return null;
        }
        if (current.updatedAt !== entry.updatedAt || current.sessionId !== entry.sessionId) {
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

  return resetCount;
}

export async function handleMSTeamsLifecycleRemove(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<MSTeamsLifecycleResetResult> {
  const reason: LifecycleResetReason | undefined = isRemoveInstallationUpdate(context)
    ? "installation-remove"
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

  let conversationRemoved = false;
  try {
    conversationRemoved = await deps.conversationStore.remove(conversationId);
  } catch (err) {
    deps.log.debug?.("failed to remove msteams conversation reference", {
      reason,
      error: formatUnknownError(err),
    });
  }

  const conversationType = getConversationType(context);
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

  const sessionsReset = await markMSTeamsSessionsStale({
    deps,
    routeSessionKey: route.sessionKey,
    agentId: route.agentId,
    includeChannelThreads: conversationType === "channel",
  });

  deps.log.info("msteams lifecycle remove handled", {
    reason,
    conversationType,
    conversationRemoved,
    sessionsReset,
  });

  return { handled: true, reason, conversationRemoved, sessionsReset };
}
