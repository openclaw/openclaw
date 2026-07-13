/**
 * In-memory registry that associates browser tabs with OpenClaw sessions for
 * cleanup on session end or idle sweeps.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { browserCloseTabByRawTargetId } from "./client.js";
import {
  acquireBrowserSessionAccess,
  acquireBrowserSessionCleanup,
  claimBrowserSessionOwner,
  isCurrentBrowserSessionOwnerClaim,
  resetBrowserSessionGatesForTests,
} from "./session-tab-gate.js";

type TrackedSessionBrowserTab = {
  sessionKey: string;
  targetId: string;
  baseUrl?: string;
  profile?: string;
  ownerId?: string;
  ownerClaim?: number;
  trackedAt: number;
  lastUsedAt: number;
};

type SessionBrowserTabIdentityParams = {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
  ownerId?: string;
  ownerClaim?: number;
};

type TrackedSessionBrowserTabIdentity = Omit<TrackedSessionBrowserTab, "trackedAt" | "lastUsedAt">;

const trackedTabsBySession = new Map<string, Map<string, TrackedSessionBrowserTab>>();

export function hasTrackedBrowserSessionTabs(sessionKey: string): boolean {
  return trackedTabsBySession.has(normalizeSessionKey(sessionKey));
}

function normalizeSessionKey(raw: string): string {
  return normalizeOptionalLowercaseString(raw) ?? "";
}

function normalizeTargetId(raw: string): string {
  return raw.trim();
}

function normalizeProfile(raw?: string): string | undefined {
  return normalizeOptionalLowercaseString(raw);
}

function normalizeBaseUrl(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOwnerId(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

function toTrackedTabId(params: { targetId: string; baseUrl?: string; profile?: string }): string {
  return `${params.targetId}\u0000${params.baseUrl ?? ""}\u0000${params.profile ?? ""}`;
}

function resolveTrackedTabIdentity(
  params: SessionBrowserTabIdentityParams,
): TrackedSessionBrowserTabIdentity | undefined {
  const sessionKeyRaw = params.sessionKey?.trim();
  const targetIdRaw = params.targetId?.trim();
  if (!sessionKeyRaw || !targetIdRaw) {
    return undefined;
  }
  return {
    sessionKey: normalizeSessionKey(sessionKeyRaw),
    targetId: normalizeTargetId(targetIdRaw),
    baseUrl: normalizeBaseUrl(params.baseUrl),
    profile: normalizeProfile(params.profile),
    ...(normalizeOwnerId(params.ownerId) ? { ownerId: normalizeOwnerId(params.ownerId) } : {}),
    ...(typeof params.ownerClaim === "number" ? { ownerClaim: params.ownerClaim } : {}),
  };
}

function trackedTabsForIdentity(
  identity: TrackedSessionBrowserTabIdentity,
): Map<string, TrackedSessionBrowserTab> | undefined {
  return trackedTabsBySession.get(identity.sessionKey);
}

function deleteTrackedTab(identity: TrackedSessionBrowserTabIdentity): void {
  const trackedForSession = trackedTabsForIdentity(identity);
  if (!trackedForSession) {
    return;
  }
  const trackedId = toTrackedTabId(identity);
  const tracked = trackedForSession.get(trackedId);
  if (!tracked || (identity.ownerId !== undefined && tracked.ownerId !== identity.ownerId)) {
    return;
  }
  trackedForSession.delete(trackedId);
  if (trackedForSession.size === 0) {
    trackedTabsBySession.delete(identity.sessionKey);
  }
}

function hasTrackedTabWithDifferentOwner(
  tab: TrackedSessionBrowserTab,
  sessionKeys: string[],
  selectedTabs: ReadonlySet<TrackedSessionBrowserTab>,
  inspectAllTrackedSessions: boolean,
): boolean {
  const trackedId = toTrackedTabId(tab);
  const trackedMaps = inspectAllTrackedSessions
    ? [...trackedTabsBySession.values()]
    : sessionKeys.map((sessionKey) => trackedTabsBySession.get(sessionKey));
  for (const trackedForSession of trackedMaps) {
    const current = trackedForSession?.get(trackedId);
    if (
      current &&
      current.ownerId !== undefined &&
      current.ownerId !== tab.ownerId &&
      !selectedTabs.has(current)
    ) {
      return true;
    }
  }
  return false;
}

function deleteTrackedTabAliases(
  tab: TrackedSessionBrowserTab,
  sessionKeys: string[],
  selectedTabs: ReadonlySet<TrackedSessionBrowserTab>,
): void {
  const trackedId = toTrackedTabId(tab);
  for (const sessionKey of sessionKeys) {
    const trackedForSession = trackedTabsBySession.get(sessionKey);
    if (!trackedForSession) {
      continue;
    }
    const current = trackedForSession.get(trackedId);
    if (!current || !selectedTabs.has(current)) {
      continue;
    }
    trackedForSession.delete(trackedId);
    if (trackedForSession.size === 0) {
      trackedTabsBySession.delete(sessionKey);
    }
  }
}

/** Claims the latest browser-tab ownership slot for a run in a session. */
export function claimTrackedBrowserSessionOwner(params: {
  sessionKey?: string;
  ownerId?: string;
}): number | undefined {
  const sessionKey = normalizeSessionKey(params.sessionKey ?? "");
  const ownerId = normalizeOwnerId(params.ownerId);
  if (!sessionKey || !ownerId) {
    return undefined;
  }
  return claimBrowserSessionOwner(sessionKey, ownerId);
}

/** Holds browser access for a session until the caller's operation completes. */
export function acquireTrackedBrowserSessionAccess(params: {
  sessionKey?: string;
}): Promise<() => void> {
  const sessionKey = normalizeSessionKey(params.sessionKey ?? "");
  if (!sessionKey) {
    return Promise.resolve(() => {});
  }
  return acquireBrowserSessionAccess(sessionKey, (key) => trackedTabsBySession.has(key));
}

function isIgnorableCloseError(err: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(String(err));
  return (
    message.includes("tab not found") ||
    message.includes("target closed") ||
    message.includes("target not found") ||
    message.includes("no such target")
  );
}

/** Starts tracking a browser tab for later session cleanup. */
export function trackSessionBrowserTab(params: SessionBrowserTabIdentityParams): void {
  const identity = resolveTrackedTabIdentity(params);
  if (!identity) {
    return;
  }
  const trackedId = toTrackedTabId(identity);
  const existing = trackedTabsBySession.get(identity.sessionKey)?.get(trackedId);
  if (
    !isCurrentBrowserSessionOwnerClaim(identity) &&
    existing !== undefined &&
    existing.ownerId !== identity.ownerId
  ) {
    return;
  }
  const now = Date.now();
  const tracked: TrackedSessionBrowserTab = {
    ...identity,
    trackedAt: now,
    lastUsedAt: now,
  };
  let trackedForSession = trackedTabsBySession.get(identity.sessionKey);
  if (!trackedForSession) {
    trackedForSession = new Map();
    trackedTabsBySession.set(identity.sessionKey, trackedForSession);
  }
  trackedForSession.set(trackedId, {
    ...tracked,
    trackedAt: existing?.trackedAt ?? tracked.trackedAt,
  });
}

/** Updates last-used time for a tracked browser tab. */
export function touchSessionBrowserTab(
  params: SessionBrowserTabIdentityParams & { now?: number },
): void {
  const identity = resolveTrackedTabIdentity(params);
  if (!identity) {
    return;
  }
  if (!isCurrentBrowserSessionOwnerClaim(identity)) {
    return;
  }
  const trackedForSession = trackedTabsForIdentity(identity);
  if (!trackedForSession) {
    return;
  }
  const trackedId = toTrackedTabId(identity);
  const tracked = trackedForSession.get(trackedId);
  if (!tracked) {
    return;
  }
  // A successor can reuse an existing target; its activity transfers cleanup
  // ownership so the predecessor cannot close the reused tab.
  trackedForSession.set(trackedId, {
    ...tracked,
    ...(identity.ownerId !== undefined
      ? { ownerId: identity.ownerId, ownerClaim: identity.ownerClaim }
      : {}),
    lastUsedAt: params.now ?? Date.now(),
  });
}

/** Removes a browser tab from session cleanup tracking. */
export function untrackSessionBrowserTab(params: SessionBrowserTabIdentityParams): void {
  const identity = resolveTrackedTabIdentity(params);
  if (!identity) {
    return;
  }
  if (!isCurrentBrowserSessionOwnerClaim(identity)) {
    return;
  }
  deleteTrackedTab(identity);
}

function listTrackedTabsForSessionKeys(
  sessionKeys: Array<string | undefined>,
  ownerId?: string,
): TrackedSessionBrowserTab[] {
  const uniqueSessionKeys = new Set<string>();
  for (const key of sessionKeys) {
    if (!key?.trim()) {
      continue;
    }
    uniqueSessionKeys.add(normalizeSessionKey(key));
  }
  if (uniqueSessionKeys.size === 0) {
    return [];
  }
  const tabs: TrackedSessionBrowserTab[] = [];
  for (const sessionKey of uniqueSessionKeys) {
    const trackedForSession = trackedTabsBySession.get(sessionKey);
    if (!trackedForSession || trackedForSession.size === 0) {
      continue;
    }
    for (const tracked of trackedForSession.values()) {
      if (ownerId !== undefined && tracked.ownerId !== undefined && tracked.ownerId !== ownerId) {
        continue;
      }
      tabs.push(tracked);
    }
  }
  return tabs;
}

async function closeTrackedTabs(params: {
  tabs: TrackedSessionBrowserTab[];
  sessionKeys: string[];
  inspectAllTrackedSessions?: boolean;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  ownerId?: string;
  onWarn?: (message: string) => void;
}): Promise<number> {
  if (params.tabs.length === 0) {
    return 0;
  }
  const closeTab =
    params.closeTab ??
    (async (tab: { targetId: string; baseUrl?: string; profile?: string }) => {
      await browserCloseTabByRawTargetId(tab.baseUrl, tab.targetId, {
        profile: tab.profile,
      });
    });
  let closed = 0;
  const selectedTabs = new Set(params.tabs);
  for (const tab of params.tabs) {
    const trackedForSession = trackedTabsBySession.get(tab.sessionKey);
    const current = trackedForSession?.get(toTrackedTabId(tab));
    if (
      current !== tab ||
      (params.ownerId !== undefined &&
        current.ownerId !== undefined &&
        current.ownerId !== params.ownerId)
    ) {
      continue;
    }
    if (
      hasTrackedTabWithDifferentOwner(
        tab,
        params.sessionKeys,
        selectedTabs,
        params.inspectAllTrackedSessions === true,
      )
    ) {
      deleteTrackedTabAliases(tab, params.sessionKeys, selectedTabs);
      continue;
    }
    try {
      await closeTab({
        targetId: tab.targetId,
        baseUrl: tab.baseUrl,
        profile: tab.profile,
      });
      closed += 1;
      deleteTrackedTabAliases(tab, params.sessionKeys, selectedTabs);
    } catch (err) {
      if (isIgnorableCloseError(err)) {
        deleteTrackedTabAliases(tab, params.sessionKeys, selectedTabs);
      } else {
        params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(err)}`);
      }
    }
  }
  return closed;
}

/** Closes and untracks tabs for the supplied session keys. */
export async function closeTrackedBrowserTabsForSessions(params: {
  sessionKeys: Array<string | undefined>;
  ownerId?: string;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
}): Promise<number> {
  const sessionKeys = [
    ...new Set(
      params.sessionKeys
        .map((sessionKey) => normalizeSessionKey(sessionKey ?? ""))
        .filter((sessionKey) => sessionKey),
    ),
  ];
  if (sessionKeys.length === 0) {
    return 0;
  }
  const releaseCleanup = await acquireBrowserSessionCleanup(sessionKeys, (key) =>
    trackedTabsBySession.has(key),
  );
  const ownerId = normalizeOwnerId(params.ownerId);
  try {
    return await closeTrackedTabs({
      tabs: listTrackedTabsForSessionKeys(sessionKeys, ownerId),
      sessionKeys,
      ownerId,
      closeTab: params.closeTab,
      onWarn: params.onWarn,
    });
  } finally {
    releaseCleanup();
  }
}

function takeStaleTrackedTabs(params: {
  now: number;
  idleMs?: number;
  maxTabsPerSession?: number;
  sessionFilter?: (sessionKey: string) => boolean;
}): TrackedSessionBrowserTab[] {
  const tabsToClose: TrackedSessionBrowserTab[] = [];
  const takenIdsBySession = new Map<string, Set<string>>();
  const mark = (sessionKey: string, trackedId: string, tracked: TrackedSessionBrowserTab): void => {
    let takenForSession = takenIdsBySession.get(sessionKey);
    if (!takenForSession) {
      takenForSession = new Set();
      takenIdsBySession.set(sessionKey, takenForSession);
    }
    if (takenForSession.has(trackedId)) {
      return;
    }
    takenForSession.add(trackedId);
    tabsToClose.push(tracked);
  };

  for (const [sessionKey, trackedForSession] of trackedTabsBySession) {
    if (params.sessionFilter && !params.sessionFilter(sessionKey)) {
      continue;
    }
    const entries = [...trackedForSession.entries()].toSorted(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt || a[1].trackedAt - b[1].trackedAt,
    );
    if (params.idleMs && params.idleMs > 0) {
      for (const [trackedId, tracked] of entries) {
        if (params.now - tracked.lastUsedAt >= params.idleMs) {
          mark(sessionKey, trackedId, tracked);
        }
      }
    }

    const remainingEntries = entries.filter(
      ([trackedId]) => !takenIdsBySession.get(sessionKey)?.has(trackedId),
    );
    if (
      params.maxTabsPerSession &&
      params.maxTabsPerSession > 0 &&
      remainingEntries.length > params.maxTabsPerSession
    ) {
      const excess = remainingEntries.length - params.maxTabsPerSession;
      for (const [trackedId, tracked] of remainingEntries.slice(0, excess)) {
        mark(sessionKey, trackedId, tracked);
      }
    }
  }

  return tabsToClose;
}

/** Closes and untracks stale or excess browser tabs across tracked sessions. */
export async function sweepTrackedBrowserTabs(params: {
  now?: number;
  idleMs?: number;
  maxTabsPerSession?: number;
  sessionFilter?: (sessionKey: string) => boolean;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
}): Promise<number> {
  const sessionKeys = [...trackedTabsBySession.keys()].filter(
    (sessionKey) => !params.sessionFilter || params.sessionFilter(sessionKey),
  );
  let closed = 0;
  for (const sessionKey of sessionKeys) {
    const releaseCleanup = await acquireBrowserSessionCleanup([sessionKey], (key) =>
      trackedTabsBySession.has(key),
    );
    try {
      closed += await closeTrackedTabs({
        tabs: takeStaleTrackedTabs({
          now: params.now ?? Date.now(),
          idleMs: params.idleMs,
          maxTabsPerSession: params.maxTabsPerSession,
          sessionFilter: (candidate) => candidate === sessionKey,
        }),
        sessionKeys: [sessionKey],
        inspectAllTrackedSessions: true,
        closeTab: params.closeTab,
        onWarn: params.onWarn,
      });
    } finally {
      releaseCleanup();
    }
  }
  return closed;
}

/** Clears tracked tab state for tests. */
export function resetTrackedSessionBrowserTabsForTests(): void {
  trackedTabsBySession.clear();
  resetBrowserSessionGatesForTests();
}

/** Counts tracked tabs for one session or all sessions in tests. */
export function countTrackedSessionBrowserTabsForTests(sessionKey?: string): number {
  if (typeof sessionKey === "string" && sessionKey.trim()) {
    return trackedTabsBySession.get(normalizeSessionKey(sessionKey))?.size ?? 0;
  }
  let count = 0;
  for (const tracked of trackedTabsBySession.values()) {
    count += tracked.size;
  }
  return count;
}
