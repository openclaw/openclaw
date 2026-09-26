import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/routing";
import { getOptionalBrowserStateRuntime } from "../browser-runtime-state.js";
import type { BrowserTabOwnership } from "./client.types.js";
import { getBrowserRequestScope } from "./request-scope.js";
import type { BrowserSessionScope } from "./session-scope.js";
import {
  clearDurableTabAliases,
  rememberDurableTabAliases,
} from "./session-tab-ephemeral-aliases.js";
import {
  activeDurableStorageKeys,
  deleteVolatileSessionTab,
  deleteVolatileRegistrations,
  type VolatileSessionTab,
  volatileTabsBySession,
} from "./session-tab-process-state.js";
import {
  assertBrowserDashboardTabCanClose,
  browserSessionTabStorageKey,
  parseBrowserSessionTabRecord,
  sameBrowserSessionTabRecord,
  withoutBrowserSessionTabCleanup,
  type BrowserSessionTabRecord,
} from "./session-tab-store.js";
import { resolveVolatile, upsertVolatile } from "./session-tab-tracking.js";

type Scope = { session?: BrowserSessionScope; assertCurrent: () => void };
type Identity = {
  targetId: string;
  profile: string;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
};
type RecordEntry = { key: string; record: BrowserSessionTabRecord };
type RegistrationCapture = { durable?: RecordEntry; volatile?: VolatileSessionTab };
type CloseAllocation = (shouldClose: () => Promise<boolean>) => Promise<unknown>;
type PreparedRegistration = {
  track: (tab: Identity) => Promise<void>;
  cleanup: (tab: Identity, close?: CloseAllocation) => Promise<void>;
};
const requests = new WeakMap<Scope, Promise<ScopedSessionTabRegistry>>();

/** Request-owned canonical view, refreshed at publication and registration boundaries. */
export function prepareScopedSessionTabRegistry(scope: Scope): Promise<ScopedSessionTabRegistry> {
  let request = requests.get(scope);
  if (!request) {
    request = createScopedRegistry(scope);
    requests.set(scope, request);
  }
  return request;
}

type ScopedSessionTabRegistry = Awaited<ReturnType<typeof createScopedRegistry>>;

async function createScopedRegistry(scope: Scope) {
  const session = scope.session;
  if (!session) {
    throw new Error("Session tab association requires a session scope");
  }
  const runtime = getOptionalBrowserStateRuntime();
  const assertRuntimeCurrent = () => {
    if (getOptionalBrowserStateRuntime() !== runtime) {
      throw new Error("Browser state runtime changed");
    }
  };
  const assertCurrent = () => {
    scope.assertCurrent();
    assertRuntimeCurrent();
  };
  const asyncStore = isIncognitoSessionKey(session.sessionKey)
    ? undefined
    : runtime?.sessionTabDiscovery;
  if (runtime?.sessionTabDiscovery && !runtime.sessionTabDiscovery.withCurrent) {
    throw new Error("Session browser tabs require the action-bound asynchronous state store");
  }
  const store: PluginStateKeyedStore<unknown, 2> | undefined = asyncStore?.withCurrent?.({
    assertCurrent,
  });
  const readCurrentRecords = async (guard: () => void) => {
    const reader = runtime?.sessionTabDiscovery.withCurrent?.({ assertCurrent: guard });
    const current = new Map<string, BrowserSessionTabRecord>();
    for (const entry of (await reader?.entries()) ?? []) {
      const record = parseBrowserSessionTabRecord(entry.value);
      if (record && browserSessionTabStorageKey(record) === entry.key) {
        current.set(entry.key, record);
      }
    }
    guard();
    return current;
  };
  let records = await readCurrentRecords(assertCurrent);
  const sessionKey = session.sessionKey.trim().toLowerCase();
  const identity = (tab: Identity) => ({
    ...session,
    sessionKey,
    targetId: tab.targetId,
    profile: tab.profile,
    route: { kind: "browser-control" as const },
  });
  const belongs = (record: {
    sessionKey: string;
    sessionId?: string;
    lifecycleRevision?: string;
  }) =>
    record.sessionKey === sessionKey &&
    record.sessionId === session.sessionId &&
    record.lifecycleRevision === session.lifecycleRevision;
  const nativeTarget = (tab: Pick<Identity, "targetId" | "ownership">) =>
    tab.ownership?.status === "durable" ? tab.ownership.nativeTargetId : tab.targetId;
  const matchesRecord = (tab: Identity, record: BrowserSessionTabRecord) =>
    record.nativeTargetId === nativeTarget(tab) &&
    record.profile === tab.profile &&
    (tab.ownership?.status !== "durable" ||
      (record.profileFingerprint === tab.ownership.profileFingerprint &&
        record.browserInstanceFingerprint === tab.ownership.browserInstanceFingerprint));
  const matchingVolatile = (tab: Identity) => {
    const matches: VolatileSessionTab[] = [];
    for (const tabs of volatileTabsBySession().values()) {
      for (const current of tabs.values()) {
        if (
          current.route.kind === "browser-control" &&
          !current.route.baseUrl &&
          current.profile === tab.profile &&
          nativeTarget(current) === nativeTarget(tab) &&
          (tab.ownership?.status !== "durable" ||
            current.ownership?.status !== "durable" ||
            (tab.ownership.profileFingerprint === current.ownership.profileFingerprint &&
              tab.ownership.browserInstanceFingerprint ===
                current.ownership.browserInstanceFingerprint))
        ) {
          matches.push(current);
        }
      }
    }
    return matches;
  };
  const isClaimed = (tab: Identity) =>
    [...records.values()].some(
      (current) =>
        matchesRecord(tab, current) &&
        (!belongs(current) || Boolean(current.dashboard) || current.cleanupKind === "lifecycle"),
    ) || matchingVolatile(tab).some((current) => !belongs(current));
  const durable = (tab: Identity): RecordEntry | undefined => {
    for (const [key, record] of records) {
      if (
        belongs(record) &&
        record.nativeTargetId ===
          (tab.ownership?.status === "durable" ? tab.ownership.nativeTargetId : tab.targetId) &&
        record.profile === tab.profile &&
        (tab.ownership?.status !== "durable" ||
          (record.profileFingerprint === tab.ownership.profileFingerprint &&
            record.browserInstanceFingerprint === tab.ownership.browserInstanceFingerprint)) &&
        !record.dashboard &&
        (record.cleanupKind !== "lifecycle" || tab.ownership?.status === "durable")
      ) {
        return { key, record };
      }
    }
    return undefined;
  };
  const clock = () =>
    Math.max(
      Date.now(),
      ...[...records.values()].filter(belongs).map((tab) => tab.lastUsedAt + 1),
      ...[...(volatileTabsBySession().get(sessionKey)?.values() ?? [])]
        .filter(belongs)
        .map((tab) => tab.lastUsedAt + 1),
    );
  const apply = async (
    key: string,
    update: (
      current: BrowserSessionTabRecord | undefined,
    ) => BrowserSessionTabRecord | null | undefined,
    prepare?: (record: BrowserSessionTabRecord) => void,
  ) => {
    if (!store) {
      throw new Error("Durable browser tab storage is unavailable");
    }
    let observed = await store.observe(key);
    for (let attempt = 0; attempt < 8; attempt++) {
      assertCurrent();
      const current = parseBrowserSessionTabRecord(observed.value);
      const next = update(current);
      if (next === undefined) {
        if (current) {
          records.set(key, current);
        } else {
          records.delete(key);
        }
        return false;
      }
      if (next) {
        prepare?.(next);
      }
      const outcome = await store.compareAndApply(
        key,
        observed.comparison,
        next === null
          ? { operation: "delete", action: "delete" }
          : { operation: "update", action: "set", value: next },
      );
      if (outcome.status === "conflict") {
        observed = outcome.current;
        continue;
      }
      assertCurrent();
      if (next) {
        records.set(key, next);
      } else {
        records.delete(key);
      }
      return true;
    }
    throw new Error("Browser tab changed repeatedly during association update");
  };
  const cleanupAllocation = async (
    capture: RegistrationCapture,
    tab: Identity,
    close?: CloseAllocation,
  ): Promise<void> => {
    assertRuntimeCurrent();
    const volatile = capture.volatile;
    const candidate = capture.durable;
    let permitted = true;
    const shouldClose = async () => {
      if (!permitted) {
        return false;
      }
      // Borrow the exact allocation, not actor authority. Recheck after transport
      // preparation at the native close and keep a revoked allocation revoked.
      const currentRecords = await readCurrentRecords(assertRuntimeCurrent);
      for (const [key, current] of currentRecords) {
        if (
          matchesRecord(tab, current) &&
          (!candidate ||
            key !== candidate.key ||
            !sameBrowserSessionTabRecord(current, candidate.record))
        ) {
          permitted = false;
        }
      }
      if (
        matchingVolatile(tab).some((current) => current.registration !== volatile?.registration) ||
        (volatile && resolveVolatile(volatile)?.tab?.registration !== volatile.registration)
      ) {
        permitted = false;
      }
      return permitted;
    };
    if (!(await shouldClose())) {
      return;
    }
    if ((await close?.(shouldClose)) === false || !(await shouldClose())) {
      return;
    }
    if (volatile) {
      deleteVolatileRegistrations([volatile]);
      return;
    }
    const cleanupStore = asyncStore?.withCurrent?.({ assertCurrent: assertRuntimeCurrent });
    if (!candidate || !cleanupStore) {
      return;
    }
    let observed = await cleanupStore.observe(candidate.key);
    for (let attempt = 0; attempt < 8; attempt++) {
      assertRuntimeCurrent();
      const current = parseBrowserSessionTabRecord(observed.value);
      if (!current || !sameBrowserSessionTabRecord(current, candidate.record)) {
        return;
      }
      const outcome = await cleanupStore.compareAndApply(candidate.key, observed.comparison, {
        operation: "delete",
        action: "delete",
      });
      if (outcome.status === "conflict") {
        observed = outcome.current;
        continue;
      }
      records.delete(candidate.key);
      clearDurableTabAliases(candidate.key);
      activeDurableStorageKeys().delete(candidate.key);
      return;
    }
    throw new Error("Browser registration changed repeatedly during compensation");
  };
  const registry = {
    async list(profile: string, ownership?: BrowserTabOwnership) {
      records = await readCurrentRecords(assertCurrent);
      const result: Array<{ targetId: string; lastUsedAt: number }> = [];
      for (const tab of volatileTabsBySession().get(sessionKey)?.values() ?? []) {
        if (
          belongs(tab) &&
          tab.profile === profile &&
          tab.route.kind === "browser-control" &&
          !tab.route.baseUrl
        ) {
          if (
            tab.ownership?.status === "durable" &&
            (ownership?.status !== "durable" ||
              tab.ownership.profileFingerprint !== ownership.profileFingerprint ||
              tab.ownership.browserInstanceFingerprint !== ownership.browserInstanceFingerprint)
          ) {
            continue;
          }
          if (
            !isClaimed({
              targetId: tab.targetId,
              profile,
              ownership:
                tab.ownership ??
                (ownership?.status === "durable"
                  ? { ...ownership, nativeTargetId: tab.targetId }
                  : ownership),
            })
          ) {
            result.push({ targetId: tab.targetId, lastUsedAt: tab.lastUsedAt });
          }
        }
      }
      if (ownership?.status === "durable") {
        for (const tab of records.values()) {
          if (
            belongs(tab) &&
            !tab.dashboard &&
            tab.cleanupKind !== "lifecycle" &&
            tab.profileFingerprint === ownership.profileFingerprint &&
            tab.browserInstanceFingerprint === ownership.browserInstanceFingerprint &&
            !isClaimed({
              targetId: tab.nativeTargetId,
              profile,
              ownership: { ...ownership, nativeTargetId: tab.nativeTargetId },
            })
          ) {
            result.push({ targetId: tab.nativeTargetId, lastUsedAt: tab.lastUsedAt });
          }
        }
      }
      return result;
    },
    async track(
      tab: Identity,
      capture?: RegistrationCapture,
      inheritFrom?: string,
    ): Promise<boolean> {
      records = await readCurrentRecords(assertCurrent);
      if (isClaimed(tab)) {
        if (inheritFrom) {
          return false;
        }
        throw new Error("Browser tab ownership changed before registration");
      }
      if (
        inheritFrom &&
        isClaimed({
          ...tab,
          targetId: inheritFrom,
          ownership:
            tab.ownership?.status === "durable"
              ? { ...tab.ownership, nativeTargetId: inheritFrom }
              : tab.ownership,
        })
      ) {
        return false;
      }
      const currentIdentity = identity(tab);
      const ownership = tab.ownership;
      if (!store || ownership?.status !== "durable") {
        upsertVolatile(currentIdentity, tab.aliases ?? [], [], ownership, clock());
        if (capture) {
          capture.volatile = resolveVolatile(currentIdentity)?.tab;
        }
        return true;
      }
      const key = browserSessionTabStorageKey({ ...ownership, sessionKey });
      await apply(
        key,
        (current) => {
          if (
            current &&
            (!belongs(current) || current.dashboard || current.cleanupKind === "lifecycle")
          ) {
            throw new Error("Browser tab ownership changed before registration");
          }
          const now = clock();
          return {
            version: 1,
            ...session,
            sessionKey,
            nativeTargetId: ownership.nativeTargetId,
            profile: tab.profile,
            profileFingerprint: ownership.profileFingerprint,
            browserInstanceFingerprint: ownership.browserInstanceFingerprint,
            interactionTargetKind: tab.targetId === ownership.nativeTargetId ? "native" : "opaque",
            trackedAt: current?.trackedAt ?? now,
            lastUsedAt: now,
          };
        },
        (record) => {
          if (capture) {
            capture.durable = { key, record };
          }
        },
      );
      rememberDurableTabAliases(currentIdentity, tab.aliases ?? [], key);
      activeDurableStorageKeys().add(key);
      return true;
    },
    inherit: (tab: Identity, openerId: string): Promise<boolean> =>
      registry.track(tab, undefined, openerId),
    cleanupAllocated: (tab: Identity, close: CloseAllocation): Promise<void> =>
      cleanupAllocation(
        {
          durable: durable(tab),
          volatile: resolveVolatile(identity(tab))?.tab,
        },
        tab,
        close,
      ),
    prepareRegistration(): PreparedRegistration {
      assertCurrent();
      const capture: RegistrationCapture = {};
      let cleanup: Promise<void> | undefined;
      return {
        track: async (tab: Identity) => {
          await registry.track(tab, capture);
        },
        // This capability can only retire the exact row/volatile registration it
        // prepared. The plugin resource owner, not a retired actor, owns compensation.
        cleanup: (tab: Identity, close?: CloseAllocation) =>
          (cleanup ??= cleanupAllocation(capture, tab, close)),
      };
    },
    async touch(tab: Identity) {
      assertCurrent();
      const volatile = resolveVolatile(identity(tab));
      if (volatile) {
        volatileTabsBySession()
          .get(sessionKey)
          ?.set(volatile.tabKey, { ...volatile.tab, lastUsedAt: clock() });
        return;
      }
      const candidate = durable(tab);
      if (!candidate) {
        return;
      }
      await apply(candidate.key, (current) =>
        current && belongs(current) && !current.dashboard && current.cleanupKind !== "lifecycle"
          ? { ...withoutBrowserSessionTabCleanup(current), lastUsedAt: clock() }
          : undefined,
      );
      activeDurableStorageKeys().add(candidate.key);
    },
    async untrack(tab: Identity) {
      assertCurrent();
      const volatile = resolveVolatile(identity(tab));
      if (volatile) {
        if (
          tab.ownership?.status === "durable" &&
          (volatile.tab.ownership?.status !== "durable" ||
            volatile.tab.ownership.nativeTargetId !== tab.ownership.nativeTargetId ||
            volatile.tab.ownership.profileFingerprint !== tab.ownership.profileFingerprint ||
            volatile.tab.ownership.browserInstanceFingerprint !==
              tab.ownership.browserInstanceFingerprint)
        ) {
          return;
        }
        deleteVolatileSessionTab(sessionKey, volatile.tabKey);
        return;
      }
      const candidate = durable(tab);
      if (!candidate) {
        return;
      }
      if (
        await apply(candidate.key, (current) =>
          current && belongs(current) && !current.dashboard ? null : undefined,
        )
      ) {
        clearDurableTabAliases(candidate.key);
        activeDurableStorageKeys().delete(candidate.key);
      }
    },
    async assertOrdinary(targetId: string, profile?: string) {
      assertCurrent();
      // Dashboard takeover can occur after inventory preparation. Close/eviction
      // checks the canonical owner at the effect boundary, including incognito callers.
      const currentStore = runtime?.sessionTabDiscovery.withCurrent?.({ assertCurrent });
      const currentRecords = (await currentStore?.entries()) ?? [];
      assertCurrent();
      for (const { value } of currentRecords) {
        const record = parseBrowserSessionTabRecord(value);
        if (!record) {
          continue;
        }
        if (
          record.nativeTargetId === targetId &&
          (!profile || record.profile === profile) &&
          record.dashboard &&
          (record.dashboard.state === "active" || record.dashboard.state === "stopping")
        ) {
          throw new Error("This tab belongs to a dashboard. Stop it from the dashboard.");
        }
      }
    },
  };
  return registry;
}

/** Scoped callers use their prepared canonical snapshot; global dashboard semantics stay unchanged. */
export async function assertSessionBrowserTabCanClose(
  targetId: string,
  profile?: string,
): Promise<void> {
  const scope = getBrowserRequestScope();
  if (scope?.session) {
    await (await prepareScopedSessionTabRegistry(scope)).assertOrdinary(targetId, profile);
  } else {
    assertBrowserDashboardTabCanClose(targetId, profile);
  }
}
