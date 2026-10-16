import type { SessionRow } from "./schema/sessions-row.js";

/** Older Gateways treat this optional conditional token as a revision miss. */
export const SESSION_ROWS_DELTA_PREFIX = "delta:";

/** Compact list omissions are unknown detail facts, never deletion receipts. */
export const SESSION_ROW_DETAIL_FIELDS = [
  "contextWindows",
  "contextWindowDefault",
  "thinkingLevels",
  "thinkingOptions",
  "thinkingDefault",
  "toolOverrides",
  "providerReview",
  "nativeRuntimeConsent",
  "contextBudgetStatus",
  "agentRuntime",
  "pluginExtensions",
] as const;

/** Gallery presentation and the facts needed to reconcile its held membership. */
export const SESSION_DASHBOARD_ROW_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "rowMode",
  "sessionId",
  "lifecycleRevision",
  "kind",
  "agentId",
  "label",
  "displayName",
  "titlePending",
  "derivedTitle",
  "lastMessagePreview",
  "accountId",
  "updatedAt",
  "snapshotAt",
  "status",
  "createdActor",
  "owner",
  "hasBoard",
  "boardFace",
  "archived",
  "pinned",
  "pinnedAt",
  "isDock",
  "sidebarRoot",
  "spawnedBy",
  "controlOwnerSessionKey",
  "parentSessionKey",
  "childSessions",
  "childOwnerSessionKeys",
  "isMain",
  "worktree",
  "repository",
  "execNode",
]);

/** Sidebar rendering, actions, and the receipts used by its managed list window. */
export const SESSION_SIDEBAR_ROW_FIELDS: ReadonlySet<string> = new Set([
  ...SESSION_DASHBOARD_ROW_FIELDS,
  "incognito",
  "icon",
  "color",
  "channelAvatarUrl",
  "category",
  "channel",
  "classification",
  "chatType",
  "subject",
  "groupChannel",
  "space",
  "origin",
  "deliveryContext",
  "createdVia",
  "createdSurface",
  "createdAt",
  "participants",
  "expandedParticipants",
  "participantCount",
  "archivedBy",
  "snoozedUntil",
  "unread",
  "lastReadAt",
  "markedUnreadAt",
  "lastActivityAt",
  "lastInteractionAt",
  "hiddenFromInvolvingMe",
  "visibility",
  "sharingRole",
  "communication",
  "effectiveCommunication",
  "hasActiveRun",
  "hasActiveSubagentRun",
  "activeRunIds",
  "subagentRunState",
  "modelSelectionLocked",
  "hasAutomation",
  "agentStatus",
  "observerDigest",
  "lastRunError",
  "abortedLastRun",
  "restartRecoveryStatus",
  "restartRecoveryCycleId",
  "startedAt",
  "endedAt",
  "runtimeMs",
  "execCwd",
  "spawnedWorkspaceDir",
  "spawnedCwd",
  "placement",
  "placementMove",
  "forkSource",
  "parentSessionId",
  "forkedFromParent",
  "spawnDepth",
  "subagentRole",
  "subagentControlScope",
  "swarmGroupId",
]);

/** Expand before any list reconciliation so the renderer only consumes normal rows. */
export function expandSessionRowFacts<T extends SessionRow>(
  sessions: T[],
  sharedFacts: Partial<T>[] | undefined,
): T[] {
  if (!sharedFacts) {
    return sessions;
  }
  return sessions.map((row) => {
    const next = { ...row };
    for (const index of row.sharedFacts ?? []) {
      Object.assign(next, sharedFacts[index]);
    }
    Object.assign(next, row);
    delete next.sharedFacts;
    return next;
  });
}
