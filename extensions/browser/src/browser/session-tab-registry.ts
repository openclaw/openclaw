/**
 * Session-owned browser tabs. Host-local durable ownership is canonical in
 * plugin SQLite; all other tabs remain process-local.
 */
import { randomUUID } from "node:crypto";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getRuntimeConfig } from "../config/config.js";
import { resolveCdpControlPolicy } from "./cdp-reachability-policy.js";
import { closeCdpTargetById, resolveCdpTabOwnership } from "./cdp.helpers.js";
import { browserCloseTabByRawTargetId } from "./client.js";
import type { BrowserTabOwnership } from "./client.types.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import {
  closeTrackedTabBatch,
  isIgnorableTabCloseError,
  runCleanupWithLifecyclePriority,
  selectStaleTrackedTabs,
  type CleanupKind,
} from "./session-tab-cleanup-orchestrator.js";
import {
  clearDurableTabAliases,
  clearVolatileTabAliases,
  forgetVolatileTabAlias,
  rememberDurableTabAliases,
  rememberVolatileTabAliases,
  resolveDurableTabAlias,
  resolveVolatileTabAlias,
} from "./session-tab-ephemeral-aliases.js";
import {
  browserSessionTabStorageKey,
  deleteBrowserSessionTabIf,
  getBrowserSessionTabStore,
  getOptionalBrowserSessionTabStore,
  parseBrowserSessionTabRecord,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
  withoutBrowserSessionTabCleanup,
  type BrowserSessionTabRecord,
} from "./session-tab-store.js";

type SessionTabParams = {
  sessionKey?: string;
  targetId?: string;
  nativeTargetId?: string;
  baseUrl?: string;
  profile?: string;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
};

type InteractionIdentity = {
  sessionKey: string;
  targetId: string;
  baseUrl?: string;
  profile?: string;
};

type VolatileTab = InteractionIdentity & {
  kind: "volatile";
  trackedAt: number;
  lastUsedAt: number;
};

type DurableRecord = BrowserSessionTabRecord;

type DurableTab = DurableRecord & {
  kind: "durable";
  storageKey: string;
};

type TrackedTab = VolatileTab | DurableTab;
type DurableOwnership = Extract<BrowserTabOwnership, { status: "durable" }>;
type CloseTab = (tab: {
  targetId: string;
  nativeTargetId?: string;
  baseUrl?: string;
  profile?: string;
}) => Promise<void>;
type CloseParams = {
  closeTab?: CloseTab;
  resolveOwnership?: (tab: DurableTab) => Promise<BrowserTabOwnership | null>;
  onWarn?: (message: string) => void;
};

const volatileStateSymbol = Symbol.for("openclaw.browser.session-tabs.volatile");

function volatileTabsBySession(): Map<string, Map<string, VolatileTab>> {
  const state = globalThis as typeof globalThis & {
    [volatileStateSymbol]?: Map<string, Map<string, VolatileTab>>;
  };
  state[volatileStateSymbol] ??= new Map();
  return state[volatileStateSymbol];
}

function normalizeSessionKey(value: string): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

function normalizeProfile(value?: string): string | undefined {
  return normalizeOptionalLowercaseString(value);
}

function resolveInteractionIdentity(params: SessionTabParams): InteractionIdentity | undefined {
  const sessionKey = params.sessionKey?.trim();
  const targetId = params.targetId?.trim();
  if (!sessionKey || !targetId) {
    return undefined;
  }
  const baseUrl = params.baseUrl?.trim();
  return {
    sessionKey: normalizeSessionKey(sessionKey),
    targetId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(normalizeProfile(params.profile) ? { profile: normalizeProfile(params.profile) } : {}),
  };
}

function durableOwnership(params: SessionTabParams): DurableOwnership | undefined {
  return params.ownership?.status === "durable" ? params.ownership : undefined;
}

function volatileId(
  identity: Pick<InteractionIdentity, "targetId" | "baseUrl" | "profile">,
): string {
  return `${identity.targetId}\u0000${identity.baseUrl ?? ""}\u0000${identity.profile ?? ""}`;
}

function deleteInvalidRecord(key: string, onWarn?: (message: string) => void): void {
  try {
    const deleted = deleteBrowserSessionTabIf(key, (current) => {
      const record = parseBrowserSessionTabRecord(current);
      return !record || browserSessionTabStorageKey(record) !== key;
    });
    if (deleted) {
      clearDurableTabAliases(key);
    }
  } catch (error) {
    onWarn?.(`failed to delete invalid browser session tab record: ${String(error)}`);
    return;
  }
  onWarn?.("deleted invalid browser session tab record");
}

function readDurableTabs(onWarn?: (message: string) => void): DurableTab[] {
  const store = getOptionalBrowserSessionTabStore();
  if (!store) {
    return [];
  }
  const tabs: DurableTab[] = [];
  for (const entry of store.entries()) {
    const record = parseBrowserSessionTabRecord(entry.value);
    if (!record || browserSessionTabStorageKey(record) !== entry.key) {
      deleteInvalidRecord(entry.key, onWarn);
      continue;
    }
    tabs.push({ ...record, kind: "durable", storageKey: entry.key });
  }
  return tabs;
}

function readDurableTab(storageKey: string): DurableTab | undefined {
  const record = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(storageKey));
  if (!record || browserSessionTabStorageKey(record) !== storageKey) {
    return undefined;
  }
  return { ...record, kind: "durable", storageKey };
}

function deleteVolatileMatching(
  identity: Pick<InteractionIdentity, "sessionKey" | "targetId" | "profile">,
): void {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey);
  if (!tabs) {
    return;
  }
  for (const [key, tab] of tabs) {
    if (tab.targetId === identity.targetId && tab.profile === identity.profile) {
      tabs.delete(key);
      clearVolatileTabAliases(identity.sessionKey, key);
    }
  }
  if (tabs.size === 0) {
    state.delete(identity.sessionKey);
  }
}

function resolveVolatile(identity: InteractionIdentity):
  | {
      tab: VolatileTab;
      tabKey: string;
    }
  | undefined {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey);
  const exactKey = volatileId(identity);
  const exact = tabs?.get(exactKey);
  if (exact) {
    return { tab: exact, tabKey: exactKey };
  }
  const target = resolveVolatileTabAlias(identity);
  if (!target || target.sessionKey !== identity.sessionKey) {
    forgetVolatileTabAlias(identity);
    return undefined;
  }
  const tab = tabs?.get(target.tabKey);
  if (!tab) {
    forgetVolatileTabAlias(identity);
    return undefined;
  }
  return { tab, tabKey: target.tabKey };
}

function deleteVolatileExact(identity: InteractionIdentity): void {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey);
  const resolved = resolveVolatile(identity);
  if (resolved) {
    tabs?.delete(resolved.tabKey);
    clearVolatileTabAliases(identity.sessionKey, resolved.tabKey);
  }
  if (tabs?.size === 0) {
    state.delete(identity.sessionKey);
  }
}

function hasVolatile(identity: InteractionIdentity): boolean {
  return Boolean(resolveVolatile(identity));
}

function upsertVolatile(
  identity: InteractionIdentity,
  aliases: Array<string | undefined>,
  now: number,
): void {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey) ?? new Map<string, VolatileTab>();
  const key = volatileId(identity);
  const existing = tabs.get(key);
  tabs.set(key, {
    ...identity,
    kind: "volatile",
    trackedAt: existing?.trackedAt ?? now,
    lastUsedAt: now,
  });
  state.set(identity.sessionKey, tabs);
  rememberVolatileTabAliases(identity, aliases, key);
}

function deleteDurableCandidate(tab: DurableTab): boolean {
  const deleted = deleteBrowserSessionTabIf(tab.storageKey, (current) => {
    const record = parseBrowserSessionTabRecord(current);
    return Boolean(record && sameBrowserSessionTabRecord(record, tab));
  });
  if (deleted) {
    clearDurableTabAliases(tab.storageKey);
  }
  return deleted;
}

function clearDurableForVolatile(
  identity: InteractionIdentity,
  ownership: DurableOwnership | undefined,
): boolean {
  const mappedKey = resolveDurableTabAlias(identity);
  const key = ownership
    ? browserSessionTabStorageKey({ sessionKey: identity.sessionKey, ...ownership })
    : mappedKey;
  if (!key) {
    return true;
  }
  const record = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(key));
  if (record) {
    return deleteDurableCandidate({ ...record, kind: "durable", storageKey: key });
  }
  clearDurableTabAliases(key);
  return true;
}

/** Starts tracking a browser tab for later session cleanup. */
export function trackSessionBrowserTab(params: SessionTabParams & { now?: number }): void {
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return;
  }
  const ownership = durableOwnership(params);
  const now = params.now ?? Date.now();
  if (!ownership || identity.baseUrl) {
    if (!clearDurableForVolatile(identity, ownership)) {
      throw new Error("durable browser tab changed during non-durable transition");
    }
    upsertVolatile(identity, params.aliases ?? [], now);
    return;
  }
  if (!identity.profile) {
    throw new Error("durable browser tab tracking requires an explicit profile");
  }
  const profile = identity.profile;
  const storageKey = browserSessionTabStorageKey({ sessionKey: identity.sessionKey, ...ownership });
  updateBrowserSessionTab(storageKey, (current) => {
    const existing = parseBrowserSessionTabRecord(current);
    return {
      version: 1,
      sessionKey: identity.sessionKey,
      nativeTargetId: ownership.nativeTargetId,
      profile,
      profileFingerprint: ownership.profileFingerprint,
      browserInstanceFingerprint: ownership.browserInstanceFingerprint,
      trackedAt: existing?.trackedAt ?? now,
      lastUsedAt: now,
    };
  });
  rememberDurableTabAliases(identity, params.aliases ?? [], storageKey);
  deleteVolatileMatching(identity);
}

function canonicalCandidate(
  params: SessionTabParams,
  identity: InteractionIdentity,
): DurableTab | undefined {
  const ownership = durableOwnership(params);
  if (!ownership) {
    const mappedKey = resolveDurableTabAlias(identity);
    if (!mappedKey) {
      return undefined;
    }
    const mappedRecord = parseBrowserSessionTabRecord(
      getBrowserSessionTabStore().lookup(mappedKey),
    );
    return mappedRecord ? { ...mappedRecord, kind: "durable", storageKey: mappedKey } : undefined;
  }
  const key = browserSessionTabStorageKey({ sessionKey: identity.sessionKey, ...ownership });
  const record = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(key));
  return record ? { ...record, kind: "durable", storageKey: key } : undefined;
}

/** Updates last-used time for an existing tracked browser tab. */
export function touchSessionBrowserTab(params: SessionTabParams & { now?: number }): void {
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return;
  }
  const now = params.now ?? Date.now();
  const volatile = resolveVolatile(identity);
  if (volatile) {
    volatile.tab.lastUsedAt = now;
  }
  if (!getOptionalBrowserSessionTabStore()) {
    return;
  }
  const candidate = canonicalCandidate(params, identity);
  if (candidate) {
    updateBrowserSessionTab(candidate.storageKey, (current) => {
      const record = parseBrowserSessionTabRecord(current);
      if (!record || !sameBrowserSessionTabRecord(record, candidate)) {
        return undefined;
      }
      if (record.cleanupKind === "sweep") {
        return { ...withoutBrowserSessionTabCleanup(record), lastUsedAt: now };
      }
      return { ...record, lastUsedAt: now };
    });
  }
}

/** Removes a browser tab from session cleanup tracking. */
export function untrackSessionBrowserTab(params: SessionTabParams): void {
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return;
  }
  deleteVolatileExact(identity);
  if (!getOptionalBrowserSessionTabStore()) {
    return;
  }
  const candidate = canonicalCandidate(params, identity);
  if (candidate) {
    deleteDurableCandidate(candidate);
  }
}

async function resolveCurrentOwnership(tab: DurableTab): Promise<BrowserTabOwnership | null> {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const profile = resolveProfile(resolved, tab.profile);
  if (!profile?.cdpUrl) {
    return null;
  }
  const cdpControlPolicy = resolveCdpControlPolicy(profile, resolved.ssrfPolicy);
  return await resolveCdpTabOwnership({
    profileName: profile.name,
    cdpUrl: profile.cdpUrl,
    nativeTargetId: tab.nativeTargetId,
    timeoutMs: resolved.remoteCdpTimeoutMs,
    ssrfPolicy: cdpControlPolicy,
  });
}

async function closeCurrentTab(tab: DurableTab): Promise<void> {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const profile = resolveProfile(resolved, tab.profile);
  if (!profile?.cdpUrl) {
    throw new Error(`browser profile "${tab.profile}" is no longer available`);
  }
  if (profile.driver === "existing-session") {
    const cdpControlPolicy = resolveCdpControlPolicy(profile, resolved.ssrfPolicy);
    await closeCdpTargetById({
      cdpUrl: profile.cdpUrl,
      targetId: tab.nativeTargetId,
      timeoutMs: resolved.actionTimeoutMs,
      ssrfPolicy: cdpControlPolicy,
    });
    return;
  }
  await browserCloseTabByRawTargetId(undefined, tab.nativeTargetId, {
    profile: tab.profile,
    timeoutMs: resolved.actionTimeoutMs,
  });
}

function ownershipMatches(record: DurableRecord, current: BrowserTabOwnership): boolean {
  return (
    current.status === "durable" &&
    current.nativeTargetId === record.nativeTargetId &&
    current.profileFingerprint === record.profileFingerprint &&
    current.browserInstanceFingerprint === record.browserInstanceFingerprint
  );
}

function claimCleanup(tab: DurableTab, now: number, kind: CleanupKind): DurableTab | undefined {
  const token = randomUUID();
  // Lifecycle is authoritative over pending sweep work. Sweep retries retain
  // their original kind so fresh activity may still revoke them.
  const cleanupKind = kind === "lifecycle" ? "lifecycle" : (tab.cleanupKind ?? kind);
  const claimed = updateBrowserSessionTab(tab.storageKey, (current) => {
    const record = parseBrowserSessionTabRecord(current);
    if (!record || !sameBrowserSessionTabRecord(record, tab)) {
      return undefined;
    }
    return {
      ...record,
      cleanupRequestedAt: now,
      cleanupAttemptToken: token,
      cleanupKind,
    };
  });
  return claimed
    ? { ...tab, cleanupRequestedAt: now, cleanupAttemptToken: token, cleanupKind }
    : undefined;
}

function matchesCleanupAttempt(
  current: BrowserSessionTabRecord | undefined,
  tab: DurableTab,
): current is BrowserSessionTabRecord {
  // Lifecycle touches advance lastUsedAt without revoking the close claim.
  // All ownership and token fields must still match before close or deletion.
  return Boolean(
    current &&
    current.cleanupAttemptToken === tab.cleanupAttemptToken &&
    current.cleanupRequestedAt === tab.cleanupRequestedAt &&
    current.cleanupKind === tab.cleanupKind &&
    sameBrowserSessionTabRecord({ ...current, lastUsedAt: tab.lastUsedAt }, tab),
  );
}

function ownsCleanupAttempt(tab: DurableTab): boolean {
  const current = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(tab.storageKey));
  return matchesCleanupAttempt(current, tab);
}

function deleteClaimedTab(tab: DurableTab, onWarn?: (message: string) => void): void {
  try {
    const deleted = deleteBrowserSessionTabIf(tab.storageKey, (current) => {
      const record = parseBrowserSessionTabRecord(current);
      return matchesCleanupAttempt(record, tab);
    });
    if (deleted) {
      clearDurableTabAliases(tab.storageKey);
    }
  } catch (error) {
    onWarn?.(`failed to delete tracked browser tab ${tab.nativeTargetId}: ${String(error)}`);
  }
}

async function performDurableCleanup(
  candidate: DurableTab,
  params: CloseParams,
  now: number,
  cleanupKind: CleanupKind,
): Promise<number> {
  const tab = claimCleanup(candidate, now, cleanupKind);
  if (!tab || !ownsCleanupAttempt(tab)) {
    return 0;
  }
  let current: BrowserTabOwnership | null;
  try {
    current = await (params.resolveOwnership ?? resolveCurrentOwnership)(tab);
  } catch (error) {
    params.onWarn?.(
      `failed to verify tracked browser tab ${tab.nativeTargetId} ownership: ${String(error)}`,
    );
    return 0;
  }
  if (!ownsCleanupAttempt(tab)) {
    return 0;
  }
  if (!current) {
    params.onWarn?.(
      `retired tracked browser tab ${tab.nativeTargetId}: profile ownership mismatch`,
    );
    deleteClaimedTab(tab, params.onWarn);
    return 0;
  }
  if (current.status !== "durable") {
    params.onWarn?.(
      `deferred tracked browser tab ${tab.nativeTargetId}: browser identity lookup was unavailable`,
    );
    return 0;
  }
  if (!ownershipMatches(tab, current)) {
    params.onWarn?.(`retired tracked browser tab ${tab.nativeTargetId}: ownership mismatch`);
    deleteClaimedTab(tab, params.onWarn);
    return 0;
  }
  try {
    if (params.closeTab) {
      await params.closeTab({
        targetId: tab.nativeTargetId,
        nativeTargetId: tab.nativeTargetId,
        profile: tab.profile,
      });
    } else {
      await closeCurrentTab(tab);
    }
  } catch (error) {
    if (isIgnorableTabCloseError(error)) {
      deleteClaimedTab(tab, params.onWarn);
      return 0;
    }
    params.onWarn?.(`failed to close tracked browser tab ${tab.nativeTargetId}: ${String(error)}`);
    return 0;
  }
  deleteClaimedTab(tab, params.onWarn);
  return 1;
}

async function closeDurableTab(
  candidate: DurableTab,
  params: CloseParams,
  now: number,
  cleanupKind: CleanupKind,
): Promise<number> {
  const run = async (tab: DurableTab) => await performDurableCleanup(tab, params, now, cleanupKind);
  return await runCleanupWithLifecyclePriority({
    key: candidate.storageKey,
    kind: cleanupKind,
    candidate,
    run,
    reread: () => readDurableTab(candidate.storageKey),
    upgradeLifecycle: (tab) => {
      claimCleanup(tab, now, "lifecycle");
    },
    retireAlreadyClosed: (tab) => {
      deleteDurableCandidate(tab);
    },
  });
}

async function performVolatileCleanup(tab: VolatileTab, params: CloseParams): Promise<number> {
  try {
    if (params.closeTab) {
      await params.closeTab({
        targetId: tab.targetId,
        ...(tab.baseUrl ? { baseUrl: tab.baseUrl } : {}),
        ...(tab.profile ? { profile: tab.profile } : {}),
      });
    } else {
      await browserCloseTabByRawTargetId(tab.baseUrl, tab.targetId, {
        profile: tab.profile,
      });
    }
  } catch (error) {
    if (isIgnorableTabCloseError(error)) {
      deleteVolatileExact(tab);
      return 0;
    }
    params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(error)}`);
    return 0;
  }
  deleteVolatileExact(tab);
  return 1;
}

async function closeVolatileTab(
  tab: VolatileTab,
  params: CloseParams,
  cleanupKind: CleanupKind,
): Promise<number> {
  const key = `volatile:${tab.sessionKey}:${volatileId(tab)}`;
  return await runCleanupWithLifecyclePriority({
    key,
    kind: cleanupKind,
    candidate: tab,
    run: async (candidate) => await performVolatileCleanup(candidate, params),
    reread: () => resolveVolatile(tab)?.tab,
  });
}

async function closeTrackedTabs(
  tabs: TrackedTab[],
  params: CloseParams & { now?: number; cleanupKind: CleanupKind },
): Promise<number> {
  return await closeTrackedTabBatch({
    tabs,
    volatileIdentity: (tab) => (tab.kind === "volatile" ? volatileId(tab) : tab.storageKey),
    close: async (tab) =>
      tab.kind === "durable"
        ? await closeDurableTab(tab, params, params.now ?? Date.now(), params.cleanupKind)
        : await closeVolatileTab(tab, params, params.cleanupKind),
    hasVolatile: (tab) => tab.kind === "volatile" && hasVolatile(tab),
    removeVolatile: (tab) => {
      if (tab.kind === "volatile") {
        deleteVolatileExact(tab);
      }
    },
  });
}

function normalizeSessionKeys(keys: Array<string | undefined>): Set<string> {
  return new Set(keys.map((key) => (key?.trim() ? normalizeSessionKey(key) : "")).filter(Boolean));
}

function volatileTabsForSessions(sessionKeys: Set<string>): VolatileTab[] {
  const result: VolatileTab[] = [];
  for (const sessionKey of sessionKeys) {
    result.push(...(volatileTabsBySession().get(sessionKey)?.values() ?? []));
  }
  return result;
}

/** Closes and untracks tabs for the supplied session keys. */
export async function closeTrackedBrowserTabsForSessions(
  params: CloseParams & { sessionKeys: Array<string | undefined> },
): Promise<number> {
  const sessionKeys = normalizeSessionKeys(params.sessionKeys);
  if (sessionKeys.size === 0) {
    return 0;
  }
  const durable = readDurableTabs(params.onWarn).filter((tab) => sessionKeys.has(tab.sessionKey));
  return await closeTrackedTabs([...durable, ...volatileTabsForSessions(sessionKeys)], {
    ...params,
    cleanupKind: "lifecycle",
  });
}

function trackedTabIdentity(tab: TrackedTab): string {
  return tab.kind === "durable"
    ? `durable:${tab.storageKey}`
    : `volatile:${tab.sessionKey}:${volatileId(tab)}`;
}

/** Closes and untracks stale, pending, or excess browser tabs. */
export async function sweepTrackedBrowserTabs(
  params: CloseParams & {
    now?: number;
    idleMs?: number;
    maxTabsPerSession?: number;
    sessionFilter?: (sessionKey: string) => boolean;
  },
): Promise<number> {
  const now = params.now ?? Date.now();
  const volatile: VolatileTab[] = [];
  for (const tabs of volatileTabsBySession().values()) {
    volatile.push(...tabs.values());
  }
  return await closeTrackedTabs(
    selectStaleTrackedTabs({
      tabs: [...readDurableTabs(params.onWarn), ...volatile],
      now,
      idleMs: params.idleMs,
      maxTabsPerSession: params.maxTabsPerSession,
      sessionFilter: params.sessionFilter,
      identity: trackedTabIdentity,
    }),
    { ...params, now, cleanupKind: "sweep" },
  );
}
