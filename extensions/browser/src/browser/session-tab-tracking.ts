import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertBrowserSessionTabAuthority,
  captureBrowserSessionTabAuthority,
  getOptionalBrowserStateRuntime,
  type BrowserDashboardRegistration,
  type BrowserSessionTabAuthority,
} from "../browser-runtime-state.js";
import type { BrowserTabOwnership } from "./client.types.js";
import {
  clearDurableTabAliases,
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
  ensureBrowserSessionTabStoreReady,
  getOptionalBrowserSessionTabStore,
  parseBrowserSessionTabRecord,
  parseBrowserDashboardStopIntent,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
  withoutBrowserSessionTabCleanup,
  withBrowserSessionTabSelection,
  withBrowserSessionTabOperation,
  withBrowserSessionTabNativeActivity,
  type BrowserSessionTabRecord,
  type BrowserSessionTabSelection,
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
  authority?: BrowserSessionTabAuthority;
};

export type DurableTab = BrowserSessionTabRecord & {
  kind: "durable";
  storageKey: string;
};

type DurableOwnership = Extract<BrowserTabOwnership, { status: "durable" }>;

function normalizeProfileAliases(values?: Array<string | undefined>): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map(normalizeOptionalLowercaseString)
        .filter((value): value is string => Boolean(value)),
    ),
  ].toSorted(compareBrowserSessionTabProfileAliases);
}

function resolveInteractionIdentity(params: SessionTabParams): InteractionIdentity | undefined {
  const sessionKey = normalizeOptionalLowercaseString(params.sessionKey);
  const targetId = params.targetId?.trim();
  if (!sessionKey || !targetId) {
    return undefined;
  }
  const profile = normalizeOptionalLowercaseString(params.profile);
  return {
    sessionKey,
    targetId,
    route: params.route ?? { kind: "browser-control" },
    ...(profile ? { profile } : {}),
  };
}

function isVolatileRoute(route: BrowserSessionTabRoute): boolean {
  return route.kind === "node-proxy" || Boolean(route.baseUrl);
}

function durableOwnership(params: SessionTabParams): DurableOwnership | undefined {
  return params.ownership?.status === "durable" ? params.ownership : undefined;
}

async function deleteInvalidRecord(
  key: string,
  authority: BrowserSessionTabAuthority,
  onWarn?: (message: string) => void,
): Promise<void> {
  try {
    await deleteBrowserSessionTabIf(
      key,
      (current) => {
        if (parseBrowserDashboardStopIntent(key, current)) {
          return false;
        }
        const record = parseBrowserSessionTabRecord(current);
        return !record || browserSessionTabStorageKey(record) !== key;
      },
      authority,
    );
  } catch (error) {
    onWarn?.(`failed to delete invalid browser session tab record: ${String(error)}`);
    return;
  }
  onWarn?.("deleted invalid browser session tab record");
}

export async function readDurableTabs(
  onWarn?: (message: string) => void,
  suppliedAuthority: BrowserSessionTabAuthority = {},
): Promise<DurableTab[]> {
  const authority = captureBrowserSessionTabAuthority(suppliedAuthority);
  const store = getOptionalBrowserSessionTabStore(authority);
  if (!store) {
    return [];
  }
  await ensureBrowserSessionTabStoreReady(authority.runtime);
  const tabs: DurableTab[] = [];
  for (const entry of await store.entries()) {
    if (parseBrowserDashboardStopIntent(entry.key, entry.value)) {
      continue;
    }
    const record = parseBrowserSessionTabRecord(entry.value);
    if (!record || browserSessionTabStorageKey(record) !== entry.key) {
      await deleteInvalidRecord(entry.key, authority, onWarn);
      continue;
    }
    tabs.push({ ...record, kind: "durable", storageKey: entry.key });
  }
  return tabs;
}

export function resolveVolatile(
  identity: InteractionIdentity,
  options?: { readOnly?: boolean },
):
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
    if (!options?.readOnly && !hasVolatileTabAlias(identity)) {
      forgetVolatileTabAlias(identity);
    }
    return undefined;
  }
  const tab = target.sessionKey === identity.sessionKey ? tabs?.get(target.tabKey) : undefined;
  if (!tab) {
    if (!options?.readOnly) {
      forgetVolatileTabAlias(identity);
    }
    return undefined;
  }
  return { tab, tabKey: target.tabKey, isExact: Boolean(exactTarget) };
}

// Membership must not call the cleanup reader, which retires invalid records.
async function readDurableTabsReadOnly(
  suppliedAuthority: BrowserSessionTabAuthority = {},
): Promise<DurableTab[]> {
  const authority = captureBrowserSessionTabAuthority(suppliedAuthority);
  const store = getOptionalBrowserSessionTabStore(authority);
  if (!store) {
    authority.assertCurrent?.();
    return [];
  }
  await ensureBrowserSessionTabStoreReady(authority.runtime);
  assertBrowserSessionTabAuthority(authority);
  const entries = await store.entries();
  assertBrowserSessionTabAuthority(authority);
  return entries.flatMap(({ key, value }) => {
    const record = parseBrowserSessionTabRecord(value);
    return record && browserSessionTabStorageKey(record) === key
      ? [{ ...record, kind: "durable" as const, storageKey: key }]
      : [];
  });
}

/** Reads session membership without changing activity, aliases, or cleanup state. */
export async function filterTrackedSessionBrowserTabs<
  T extends { targetId: string; tabId?: string },
>(
  params: Pick<SessionTabParams, "route" | "profile" | "authority"> & {
    sessionKey: string;
    tabs: readonly T[];
  },
): Promise<T[]> {
  const sessionKey = normalizeOptionalLowercaseString(params.sessionKey);
  if (!sessionKey || params.tabs.length === 0) {
    return [];
  }
  const route = params.route ?? { kind: "browser-control" };
  const profile = normalizeOptionalLowercaseString(params.profile);
  const durableKeys = new Set<string>();
  const nativeIdentities = new Set<string>();
  if (!isVolatileRoute(route) && profile) {
    for (const record of await readDurableTabsReadOnly(params.authority)) {
      if (
        record.sessionKey !== sessionKey ||
        (record.profile !== profile && !record.profileAliases?.includes(profile))
      ) {
        continue;
      }
      durableKeys.add(record.storageKey);
      nativeIdentities.add(browserSessionTabNativeIdentity({ ...record, profile }));
    }
  }
  return params.tabs.filter((tab) =>
    [tab.targetId, tab.tabId].some((targetId) => {
      const identity = resolveInteractionIdentity({ sessionKey, route, profile, targetId });
      if (!identity) {
        return false;
      }
      if (resolveVolatile(identity, { readOnly: true })) {
        return true;
      }
      const storageKey = resolveDurableTabExact(identity) ?? resolveDurableTabAlias(identity);
      return (
        (storageKey !== undefined && durableKeys.has(storageKey)) ||
        (profile !== undefined &&
          nativeIdentities.has(
            browserSessionTabNativeIdentity({
              sessionKey,
              profile,
              nativeTargetId: identity.targetId,
            }),
          ))
      );
    }),
  );
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

async function clearDurableForVolatile(
  identity: InteractionIdentity,
  authority: BrowserSessionTabAuthority,
  onCleared: () => void,
): Promise<boolean> {
  const mappedKey = resolveDurableTabExact(identity);
  if (!mappedKey) {
    if (authority.runtime) {
      assertBrowserSessionTabAuthority(authority);
    }
    onCleared();
    return true;
  }
  return await withBrowserSessionTabSelection(mappedKey, authority, async (tab) => {
    const record = parseBrowserSessionTabRecord(await tab.lookup());
    assertBrowserSessionTabAuthority(authority);
    if (record) {
      if (
        !(await tab.deleteIf((current) => {
          const selected = parseBrowserSessionTabRecord(current);
          return Boolean(selected && sameBrowserSessionTabRecord(selected, record));
        }))
      ) {
        return false;
      }
    } else {
      clearDurableTabAliases(mappedKey);
      activeDurableStorageKeys().delete(mappedKey);
    }
    assertBrowserSessionTabAuthority(authority);
    onCleared();
    return true;
  });
}

export function withBrowserDashboardRegistration<T, Authority extends BrowserSessionTabAuthority>(
  targetId: string,
  profile: string | undefined,
  authority: Authority,
  register: (current: Authority) => Promise<T>,
): Promise<T> {
  if (authority.dashboardRegistration) {
    return register(authority);
  }
  const registration: BrowserDashboardRegistration = {
    kind: "dashboard-registration",
    targetId,
    profile,
  };
  const current = {
    ...authority,
    dashboardRegistration: registration,
    assertCurrent: () => {
      authority.assertCurrent?.();
      if (registration.closeDispatched) {
        throw new Error("Browser dashboard close was dispatched during registration");
      }
    },
  };
  return withBrowserSessionTabOperation(registration, current, () => register(current));
}

/** Starts tracking a browser tab for later session cleanup. */
export async function trackSessionBrowserTab(
  input: SessionTabParams & { now?: number },
): Promise<DurableTab | undefined> {
  const params = {
    ...input,
    authority: captureBrowserSessionTabAuthority(input.authority),
  };
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return undefined;
  }
  const ownership = durableOwnership(params);
  const profileAliases = normalizeProfileAliases(params.profileAliases);
  const now = params.now ?? Date.now();
  if (isVolatileRoute(identity.route)) {
    upsertVolatile(identity, params.aliases ?? [], profileAliases, params.ownership, now);
    return undefined;
  }
  const register = async (
    authority: BrowserSessionTabAuthority,
  ): Promise<DurableTab | undefined> => {
    await ensureBrowserSessionTabStoreReady(authority.runtime);
    if (!ownership) {
      if (
        !(await clearDurableForVolatile(identity, authority, () => {
          upsertVolatile(identity, params.aliases ?? [], profileAliases, params.ownership, now);
        }))
      ) {
        throw new Error("durable browser tab changed during non-durable transition");
      }
      return undefined;
    }
    if (!identity.profile) {
      throw new Error("durable browser tab tracking requires an explicit profile");
    }
    const profile = identity.profile;
    const storageKey = browserSessionTabStorageKey({
      ...ownership,
      sessionKey: identity.sessionKey,
    });
    const registered = await updateBrowserSessionTab(
      storageKey,
      (current) => {
        const existing = parseBrowserSessionTabRecord(current);
        const persistedProfileAliases = normalizeProfileAliases([
          ...(existing?.profileAliases ?? []),
          existing?.profile,
          ...profileAliases,
        ]).filter((alias) => alias !== profile);
        return {
          version: 1,
          sessionKey: identity.sessionKey,
          nativeTargetId: ownership.nativeTargetId,
          profile,
          ...(persistedProfileAliases.length > 0
            ? { profileAliases: persistedProfileAliases }
            : {}),
          profileFingerprint: ownership.profileFingerprint,
          browserInstanceFingerprint: ownership.browserInstanceFingerprint,
          interactionTargetKind:
            identity.targetId === ownership.nativeTargetId ? "native" : "opaque",
          trackedAt: existing?.trackedAt ?? now,
          lastUsedAt: now,
          ...(params.dashboard
            ? { dashboard: params.dashboard }
            : existing?.dashboard
              ? { dashboard: existing.dashboard }
              : {}),
        };
      },
      {
        ...authority,
        onCommitted: (record) => {
          rememberDurableTabAliases(
            identity,
            params.aliases ?? [],
            storageKey,
            record.profileAliases,
          );
          activeDurableStorageKeys().add(storageKey);
          deleteVolatileSessionTab(identity.sessionKey, volatileSessionTabTargetKey(identity));
        },
      },
    );
    return registered ? { ...registered, kind: "durable", storageKey } : undefined;
  };
  return params.dashboard && ownership
    ? await withBrowserDashboardRegistration(
        ownership.nativeTargetId,
        identity.profile,
        params.authority,
        register,
      )
    : await register(params.authority);
}

function canonicalStorageKey(
  params: SessionTabParams,
  identity: InteractionIdentity,
): string | undefined {
  const ownership = durableOwnership(params);
  if (ownership && !identity.profile) {
    return undefined;
  }
  return ownership
    ? browserSessionTabStorageKey({ ...ownership, sessionKey: identity.sessionKey })
    : resolveDurableTabAlias(identity);
}

/** Updates last-used time for an existing tracked browser tab. */
export async function touchSessionBrowserTab(
  input: SessionTabParams & { now?: number },
): Promise<void> {
  const params = {
    ...input,
    authority: captureBrowserSessionTabAuthority(input.authority),
  };
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
  if (isVolatileRoute(identity.route) || !getOptionalBrowserSessionTabStore()) {
    return;
  }
  await ensureBrowserSessionTabStoreReady(params.authority.runtime);
  const key = canonicalStorageKey(params, identity);
  if (
    key &&
    (await withBrowserSessionTabSelection(key, params.authority, async (tab) => {
      const candidate = parseBrowserSessionTabRecord(await tab.lookup());
      if (!candidate) {
        return false;
      }
      await tab.update(
        (current) => {
          const record = parseBrowserSessionTabRecord(current);
          if (!record || !sameBrowserSessionTabRecord(record, candidate)) {
            return undefined;
          }
          if (record.cleanupKind === "sweep") {
            return { ...withoutBrowserSessionTabCleanup(record), lastUsedAt: now };
          }
          return { ...record, lastUsedAt: now };
        },
        () => activeDurableStorageKeys().add(key),
      );
      return true;
    }))
  ) {
    return;
  }
  if (identity.profile) {
    const nativeTargetId = params.nativeTargetId?.trim() || identity.targetId;
    const coldIdentity = browserSessionTabNativeIdentity({
      sessionKey: identity.sessionKey,
      profile: identity.profile,
      nativeTargetId,
    });
    await withBrowserSessionTabNativeActivity(coldIdentity, params.authority, async (store) => {
      if (
        readColdNativeActivity(coldIdentity) !== undefined ||
        (await store.entries()).some(({ key: entryKey, value }) => {
          const tab = parseBrowserSessionTabRecord(value);
          return (
            tab?.interactionTargetKind === "native" &&
            browserSessionTabNativeIdentity(tab) === coldIdentity &&
            browserSessionTabStorageKey(tab) === entryKey
          );
        })
      ) {
        if (getOptionalBrowserStateRuntime() === params.authority.runtime) {
          rememberColdNativeActivity(coldIdentity, now);
        }
      }
    });
  }
}

/** Removes a browser tab from session cleanup tracking. */
export async function untrackSessionBrowserTab(input: SessionTabParams): Promise<void> {
  const params = {
    ...input,
    authority: captureBrowserSessionTabAuthority(input.authority),
  };
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return;
  }
  const initialVolatile = resolveVolatile(identity);
  if (isVolatileRoute(identity.route) || !getOptionalBrowserSessionTabStore()) {
    if (initialVolatile) {
      deleteVolatileSessionTab(identity.sessionKey, initialVolatile.tabKey);
    }
    return;
  }
  await ensureBrowserSessionTabStoreReady(params.authority.runtime);
  const key = canonicalStorageKey(params, identity);
  const untrack = async (tab?: BrowserSessionTabSelection) => {
    const record = tab ? parseBrowserSessionTabRecord(await tab.lookup()) : undefined;
    assertBrowserSessionTabAuthority(params.authority);
    const volatile = resolveVolatile(identity);
    const deleteSelected = async () => {
      if (tab && record) {
        await tab.deleteIf((current) => {
          const selected = parseBrowserSessionTabRecord(current);
          return Boolean(selected && sameBrowserSessionTabRecord(selected, record));
        });
      }
    };
    if (record && durableOwnership(params)) {
      await deleteSelected();
      return;
    }
    const selection = selectSessionTabToUntrack({
      volatileAvailable: Boolean(volatile),
      durableAvailable: Boolean(record),
      hasVolatileCandidate: Boolean(volatile) || hasVolatileTabAlias(identity),
      hasDurableCandidate: Boolean(record) || hasDurableTabAlias(identity),
      volatileIsExact: volatile?.isExact ?? false,
      durableIsExact: Boolean(record && resolveDurableTabExact(identity) === key),
      hasVolatileExactCandidate: hasVolatileTabExact(identity),
      hasDurableExactCandidate: hasDurableTabExact(identity),
    });
    if (selection === "volatile" && volatile) {
      deleteVolatileSessionTab(identity.sessionKey, volatile.tabKey);
    } else if (selection === "durable") {
      await deleteSelected();
    } else if (selection === "missing" && identity.profile) {
      const identityKey = browserSessionTabNativeIdentity({
        sessionKey: identity.sessionKey,
        profile: identity.profile,
        nativeTargetId: params.nativeTargetId?.trim() || identity.targetId,
      });
      await withBrowserSessionTabNativeActivity(identityKey, params.authority, async () => {
        forgetColdNativeActivity(identityKey);
      });
    }
  };
  if (key) {
    await withBrowserSessionTabSelection(key, params.authority, untrack);
  } else {
    await untrack();
  }
}
