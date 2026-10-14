import type { SessionRow } from "./schema/sessions-row.js";

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

/** Response-local facts: no cross-request catalog or invalidation protocol. */
export function shareSessionRowFacts<T extends SessionRow>(sessions: T[]) {
  type SharedFact = { fact: Partial<T>; rows: { index: number; row: T }[] };
  const candidates = new Map<string, SharedFact>();
  const rows = sessions.map((row) => ({ ...row }));
  rows.forEach((row, index) => {
    const recipient = { index, row };
    for (const field in row) {
      const value = row[field];
      // Keep required fields and the projection marker readable without expanding the table.
      if (
        value === undefined ||
        ["key", "kind", "updatedAt", "sessionId", "rowMode"].includes(field)
      ) {
        continue;
      }
      const fact: Partial<T> = {};
      fact[field] = value;
      const key = JSON.stringify(fact);
      const candidate = candidates.get(key);
      if (candidate) {
        candidate.rows.push(recipient);
      } else {
        candidates.set(key, { fact, rows: [recipient] });
      }
    }
  });
  // Facts with the same recipients share one reference, including common scalar defaults.
  const groups = new Map<string, SharedFact>();
  for (const candidate of candidates.values()) {
    if (candidate.rows.length < 2) {
      continue;
    }
    const key = candidate.rows.map(({ index }) => index).join(",");
    const group = groups.get(key);
    if (group) {
      Object.assign(group.fact, candidate.fact);
    } else {
      groups.set(key, candidate);
    }
  }
  const sharedFacts: Partial<T>[] = [];
  for (const group of groups.values()) {
    const reference = sharedFacts.push(group.fact) - 1;
    const fields = Object.keys(group.fact);
    for (const { row } of group.rows) {
      for (const field of fields) {
        Reflect.deleteProperty(row, field);
      }
      (row.sharedFacts ??= []).push(reference);
    }
  }
  return { sessions: rows, sharedFacts };
}

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
