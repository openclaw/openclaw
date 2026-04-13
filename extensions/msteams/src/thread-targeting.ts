function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stripConversationPrefix(value: string): string {
  return value.startsWith("conversation:") ? value.slice("conversation:".length).trim() : value;
}

export type MSTeamsThreadTarget = {
  teamId: string;
  channelId: string;
  rootMessageId: string;
  conversationId: string;
};

export function resolveMSTeamsThreadTarget(params: {
  rawParams: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | null;
    currentParentConversationId?: string | null;
    currentThreadRootId?: string | null;
  };
}): MSTeamsThreadTarget {
  const teamId = readTrimmedString(params.rawParams.teamId);
  const channelId = readTrimmedString(params.rawParams.channelId);
  const rootMessageId =
    readTrimmedString(params.rawParams.rootMessageId) ??
    readTrimmedString(params.rawParams.messageId) ??
    readTrimmedString(params.toolContext?.currentThreadRootId);
  const conversationId = stripConversationPrefix(
    readTrimmedString(params.rawParams.conversationId) ??
      readTrimmedString(params.toolContext?.currentParentConversationId) ??
      readTrimmedString(params.toolContext?.currentChannelId) ??
      "",
  );
  if (!teamId || !channelId || !rootMessageId) {
    throw new Error("Explicit teamId, channelId, and rootMessageId are required.");
  }
  if (!conversationId) {
    throw new Error(
      "Teams thread actions require an explicit conversationId or current thread context.",
    );
  }
  return {
    teamId,
    channelId,
    rootMessageId,
    conversationId,
  };
}

export function readMSTeamsApproverIds(rawParams: Record<string, unknown>): string[] {
  const raw =
    (Array.isArray(rawParams.approverIds) ? rawParams.approverIds : undefined) ??
    (Array.isArray(rawParams.approvers) ? rawParams.approvers : undefined);
  const approverIds = (raw ?? [])
    .map((entry) => readTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const approverId = readTrimmedString(rawParams.approverId);
  if (approverId) {
    approverIds.push(approverId);
  }
  return Array.from(new Set(approverIds));
}
