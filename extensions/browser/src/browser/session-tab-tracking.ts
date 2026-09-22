import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserTabOwnership } from "./client.types.js";
import {
  clearDurableTabAliases,
  clearVolatileTabAliases,
  forgetVolatileTabAlias,
  hasDurableTabAlias,
  hasDurableTabExact,
  hasVolatileTabAlias,
  hasVolatileTabExact,
  rememberDurableTabAliases,
  rememberVolatileTabAliases,
  resolveDurableTabAlias,
  resolveDurableTabExact,
  resolveVolatileTabAlias,
  resolveVolatileTabExact,
} from "./session-tab-ephemeral-aliases.js";
import {
  activeDurableStorageKeys,
  deleteVolatileSessionTab,
  forgetColdNativeActivity,
  normalizeBrowserSessionKey,
  readColdNativeActivity,
  rememberColdNativeActivity,
  type SessionTabInteractionIdentity as InteractionIdentity,
  type VolatileSessionTab as VolatileTab,
  volatileSessionTabTargetKey,
  volatileTabsBySession,
} from "./session-tab-process-state.js";
import type { BrowserSessionTabRoute } from "./session-tab-route.js";
import {
  browserSessionTabNativeIdentity,
  browserSessionTabStorageKey,
  compareBrowserSessionTabProfileAliases,
  deleteBrowserSessionTabIf,
  getBrowserSessionTabStore,
  getOptionalBrowserSessionTabStore,
  parseBrowserSessionTabRecord,
  parseBrowserDashboardStopIntent,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
  withoutBrowserSessionTabCleanup,
  type BrowserSessionTabRecord,
} from "./session-tab-store.js";
import { selectSessionTabToUntrack } from "./session-tab-untrack-selection.js";

type SessionTabParams = {
  sessionKey?: string;
  targetId?: string;
  nativeTargetId?: string;
  route?: BrowserSessionTabRoute;
  profile?: string;
  profileAliases?: Array<string | undefined>;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
  dashboard?: BrowserSessionTabRecord["dashboard"];
};

export type DurableTab = BrowserSessionTabRecord & {
  kind: "durable";
  storageKey: string;
};

type DurableOwnership = Extract<BrowserTabOwnership, { status: "durable" }>;

function normalizeProfile(value?: string): string | undefined {
  return normalizeOptionalLowercaseString(value);
}

function normalizeProfileAliases(values?: Array<string | undefined>): string[] {
  return [
    ...new Set(
      (values ?? []).map(normalizeProfile).filter((value): value is string => Boolean(value)),
    ),
  ].toSorted(compareBrowserSessionTabProfileAliases);
}

function resolveInteractionIdentity(params: SessionTabParams): InteractionIdentity | undefined {
  const sessionKey = params.sessionKey?.trim();
  const targetId = params.targetId?.trim();
  if (!sessionKey || !targetId) {
    return undefined;
  }
  return {
    sessionKey: normalizeBrowserSessionKey(sessionKey) ?? "",
    targetId,
    route: params.route ?? { kind: "browser-control" },
    ...(normalizeProfile(params.profile) ? { profile: normalizeProfile(params.profile) } : {}),
  };
}

function isVolatileRoute(route: BrowserSessionTabRoute): boolean {
  return route.kind === "node-proxy" || Boolean(route.baseUrl);
}

function durableOwnership(params: SessionTabParams): DurableOwnership | undefined {
  return params.ownership?.status === "durable" ? params.ownership : undefined;
}

function deleteInvalidRecord(key: string, onWarn?: (message: string) => void): void {
  try {
    const deleted = deleteBrowserSessionTabIf(key, (current) => {
      if (parseBrowserDashboardStopIntent(key, current)) {
        return false;
      }
      const record = parseBrowserSessionTabRecord(current);
      return !record || browserSessionTabStorageKey(record) !== key;
    });
    if (deleted) {
      clearDurableTabAliases(key);
      activeDurableStorageKeys().delete(key);
    }
  } catch (error) {
    onWarn?.(`failed to delete invalid browser session tab record: ${String(error)}`);
    return;
  }
  onWarn?.("deleted invalid browser session tab record");
}

export function readDurableTabs(onWarn?: (message: string) => void): DurableTab[] {
  const store = getOptionalBrowserSessionTabStore();
  if (!store) {
    return [];
  }
  const tabs: DurableTab[] = [];
  for (const entry of store.entries()) {
    if (parseBrowserDashboardStopIntent(entry.key, entry.value)) {
      continue;
    }
    const record = parseBrowserSessionTabRecord(entry.value);
    if (!record || browserSessionTabStorageKey(record) !== entry.key) {
      deleteInvalidRecord(entry.key, onWarn);
      continue;
    }
    tabs.push({ ...record, kind: "durable", storageKey: entry.key });
  }
  return tabs;
}

function deleteVolatileMatching(
  identity: Pick<InteractionIdentity, "sessionKey" | "targetId" | "route" | "profile">,
): void {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey);
  if (!tabs) {
    return;
  }
  for (const [key, tab] of tabs) {
    if (volatileSessionTabTargetKey(tab) === volatileSessionTabTargetKey(identity)) {
      tabs.delete(key);
      clearVolatileTabAliases(identity.sessionKey, key);
    }
  }
  if (tabs.size === 0) {
    state.delete(identity.sessionKey);
  }
}

export function resolveVolatile(identity: InteractionIdentity):
  | {
      tab: VolatileTab;
      tabKey: string;
      isExact: boolean;
    }
  | undefined {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey);
  const exactKey = volatileSessionTabTargetKey(identity);
  const exact = tabs?.get(exactKey);
  if (exact) {
    return { tab: exact, tabKey: exactKey, isExact: true };
  }
  const exactTarget = resolveVolatileTabExact(identity);
  if (!exactTarget && hasVolatileTabExact(identity)) {
    return undefined;
  }
  const target = exactTarget ?? resolveVolatileTabAlias(identity);
  if (!target) {
    if (!hasVolatileTabAlias(identity)) {
      forgetVolatileTabAlias(identity);
    }
    return undefined;
  }
  if (target.sessionKey !== identity.sessionKey) {
    forgetVolatileTabAlias(identity);
    return undefined;
  }
  const tab = tabs?.get(target.tabKey);
  if (!tab) {
    forgetVolatileTabAlias(identity);
    return undefined;
  }
  return { tab, tabKey: target.tabKey, isExact: Boolean(exactTarget) };
}

function upsertVolatile(
  identity: InteractionIdentity,
  aliases: Array<string | undefined>,
  profileAliases: Array<string | undefined>,
  ownership: BrowserTabOwnership | undefined,
  now: number,
): void {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey) ?? new Map<string, VolatileTab>();
  const key = volatileSessionTabTargetKey(identity);
  const existing = tabs.get(key);
  tabs.set(key, {
    ...identity,
    kind: "volatile",
    registration: {},
    ...(ownership ? { ownership } : {}),
    trackedAt: existing?.trackedAt ?? now,
    lastUsedAt: now,
  });
  state.set(identity.sessionKey, tabs);
  rememberVolatileTabAliases(identity, aliases, key, profileAliases);
}

function deleteDurableCandidate(tab: DurableTab): boolean {
  const deleted = deleteBrowserSessionTabIf(tab.storageKey, (current) => {
    const record = parseBrowserSessionTabRecord(current);
    return Boolean(record && sameBrowserSessionTabRecord(record, tab));
  });
  if (deleted) {
    clearDurableTabAliases(tab.storageKey);
    activeDurableStorageKeys().delete(tab.storageKey);
  }
  return deleted;
}

function clearDurableForVolatile(identity: InteractionIdentity): boolean {
  const mappedKey = resolveDurableTabExact(identity);
  if (!mappedKey) {
    return true;
  }
  const record = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(mappedKey));
  if (record) {
    return deleteDurableCandidate({ ...record, kind: "durable", storageKey: mappedKey });
  }
  clearDurableTabAliases(mappedKey);
  activeDurableStorageKeys().delete(mappedKey);
  return true;
}

/** Starts tracking a browser tab for later session cleanup. */
export function trackSessionBrowserTab(params: SessionTabParams & { now?: number }): void {
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return;
  }
  const ownership = durableOwnership(params);
  const profileAliases = normalizeProfileAliases(params.profileAliases);
  const now = params.now ?? Date.now();
  if (isVolatileRoute(identity.route)) {
    upsertVolatile(identity, params.aliases ?? [], profileAliases, params.ownership, now);
    return;
  }
  if (!ownership) {
    if (!clearDurableForVolatile(identity)) {
      throw new Error("durable browser tab changed during non-durable transition");
    }
    upsertVolatile(identity, params.aliases ?? [], profileAliases, params.ownership, now);
    return;
  }
  if (!identity.profile) {
    throw new Error("durable browser tab tracking requires an explicit profile");
  }
  const profile = identity.profile;
  const storageKey = browserSessionTabStorageKey({
    sessionKey: identity.sessionKey,
    nativeTargetId: ownership.nativeTargetId,
    profileFingerprint: ownership.profileFingerprint,
    browserInstanceFingerprint: ownership.browserInstanceFingerprint,
  });
  let persistedProfileAliases: string[] = [];
  updateBrowserSessionTab(storageKey, (current) => {
    const existing = parseBrowserSessionTabRecord(current);
    persistedProfileAliases = normalizeProfileAliases([
      ...(existing?.profileAliases ?? []),
      existing?.profile,
      ...profileAliases,
    ]).filter((alias) => alias !== profile);
    return {
      version: 1,
      sessionKey: identity.sessionKey,
      nativeTargetId: ownership.nativeTargetId,
      profile,
      ...(persistedProfileAliases.length > 0 ? { profileAliases: persistedProfileAliases } : {}),
      profileFingerprint: ownership.profileFingerprint,
      browserInstanceFingerprint: ownership.browserInstanceFingerprint,
      interactionTargetKind: identity.targetId === ownership.nativeTargetId ? "native" : "opaque",
      trackedAt: existing?.trackedAt ?? now,
      lastUsedAt: now,
      ...(params.dashboard
        ? { dashboard: params.dashboard }
        : existing?.dashboard
          ? { dashboard: existing.dashboard }
          : {}),
    };
  });
  rememberDurableTabAliases(identity, params.aliases ?? [], storageKey, persistedProfileAliases);
  activeDurableStorageKeys().add(storageKey);
  deleteVolatileMatching(identity);
}

function canonicalCandidate(
  params: SessionTabParams,
  identity: InteractionIdentity,
): DurableTab | undefined {
  const ownership = durableOwnership(params);
  if (!ownership) {
    const mappedKey = resolveDurableTabAlias(identity);
    if (mappedKey) {
      const mappedRecord = parseBrowserSessionTabRecord(
        getBrowserSessionTabStore().lookup(mappedKey),
      );
      if (mappedRecord) {
        return { ...mappedRecord, kind: "durable", storageKey: mappedKey };
      }
    }
    return undefined;
  }
  if (!identity.profile) {
    return undefined;
  }
  const key = browserSessionTabStorageKey({
    sessionKey: identity.sessionKey,
    nativeTargetId: ownership.nativeTargetId,
    profileFingerprint: ownership.profileFingerprint,
    browserInstanceFingerprint: ownership.browserInstanceFingerprint,
  });
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
    volatileTabsBySession()
      .get(identity.sessionKey)
      ?.set(volatile.tabKey, { ...volatile.tab, lastUsedAt: now });
  }
  if (isVolatileRoute(identity.route)) {
    return;
  }
  if (!getOptionalBrowserSessionTabStore()) {
    return;
  }
  const candidate = canonicalCandidate(params, identity);
  if (candidate) {
    activeDurableStorageKeys().add(candidate.storageKey);
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
    return;
  }
  if (identity.profile) {
    const nativeTargetId = params.nativeTargetId?.trim() || identity.targetId;
    const coldIdentity = browserSessionTabNativeIdentity({
      sessionKey: identity.sessionKey,
      profile: identity.profile,
      nativeTargetId,
    });
    if (
      readColdNativeActivity(coldIdentity) !== undefined ||
      readDurableTabs().some(
        (tab) =>
          tab.interactionTargetKind === "native" &&
          browserSessionTabNativeIdentity(tab) === coldIdentity,
      )
    ) {
      rememberColdNativeActivity(coldIdentity, now);
    }
  }
}

/** Removes a browser tab from session cleanup tracking. */
export function untrackSessionBrowserTab(params: SessionTabParams): void {
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return;
  }
  const volatile = resolveVolatile(identity);
  if (isVolatileRoute(identity.route)) {
    if (volatile) {
      deleteVolatileSessionTab(identity.sessionKey, volatile.tabKey);
    }
    return;
  }
  if (!getOptionalBrowserSessionTabStore()) {
    if (volatile) {
      deleteVolatileSessionTab(identity.sessionKey, volatile.tabKey);
    }
    return;
  }
  const durable = canonicalCandidate(params, identity);
  if (durable && durableOwnership(params)) {
    deleteDurableCandidate(durable);
    return;
  }
  const selection = selectSessionTabToUntrack({
    volatileAvailable: Boolean(volatile),
    durableAvailable: Boolean(durable),
    hasVolatileCandidate: Boolean(volatile) || hasVolatileTabAlias(identity),
    hasDurableCandidate: Boolean(durable) || hasDurableTabAlias(identity),
    volatileIsExact: volatile?.isExact ?? false,
    durableIsExact: Boolean(durable && resolveDurableTabExact(identity) === durable.storageKey),
    hasVolatileExactCandidate: hasVolatileTabExact(identity),
    hasDurableExactCandidate: hasDurableTabExact(identity),
  });
  if (selection === "volatile" && volatile) {
    deleteVolatileSessionTab(identity.sessionKey, volatile.tabKey);
    return;
  }
  if (selection === "durable" && durable) {
    deleteDurableCandidate(durable);
    return;
  }
  if (selection !== "missing") {
    return;
  }
  if (identity.profile) {
    forgetColdNativeActivity(
      browserSessionTabNativeIdentity({
        sessionKey: identity.sessionKey,
        profile: identity.profile,
        nativeTargetId: params.nativeTargetId?.trim() || identity.targetId,
      }),
    );
  }
}
