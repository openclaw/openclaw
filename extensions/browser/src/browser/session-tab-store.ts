import { createHash, randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { z } from "zod";
import type { BrowserDashboardIdentity } from "../browser-dashboard.types.js";
import {
  assertBrowserSessionTabAuthority,
  getBrowserStateRuntime,
  getPendingBrowserDashboardRegistrations,
  getOptionalBrowserStateRuntime,
  setBrowserStateRuntime,
  type BrowserStateRuntime,
  type BrowserSessionTabOperationKey,
  type BrowserSessionTabAuthority,
} from "../browser-runtime-state.js";
import {
  clearDurableTabAliases,
  rememberDurableTabAliases,
  resetDurableTabAliases,
} from "./session-tab-ephemeral-aliases.js";
import {
  browserSessionTabNativeIdentity,
  browserSessionTabStorageKey,
  resolveBrowserSessionKey,
} from "./session-tab-identity.js";
import {
  activeDurableStorageKeys,
  forgetColdNativeActivity,
  readColdNativeActivity,
} from "./session-tab-process-state.js";

const BROWSER_SESSION_TABS_NAMESPACE = "browser.session-tabs";
const BROWSER_SESSION_TABS_MAX_ENTRIES = 5_000;
const logger = createSubsystemLogger("browser");

const browserSessionTimestampSchema = z.number().finite().nonnegative();
const browserDashboardStopIntentSchema = z.strictObject({
  kind: z.literal("dashboard-stop"),
  version: z.literal(1),
  stopId: z.uuid(),
  sessionKey: z.string().min(1),
  agentId: z.string().min(1),
  name: z.string().min(1).max(64),
  instanceId: z.string().min(1),
  url: z.string().min(1).max(4096),
  profile: z.string().min(1),
});
const browserProfileAliasSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim().toLowerCase());
const browserSessionTabRecordSchema = z
  .looseObject({
    version: z.literal(1),
    sessionKey: z.string().min(1),
    nativeTargetId: z.string().min(1),
    profile: z.string().min(1),
    profileAliases: z.array(browserProfileAliasSchema).min(1).optional(),
    profileFingerprint: z.string().min(1),
    browserInstanceFingerprint: z.string().min(1),
    interactionTargetKind: z.enum(["native", "opaque"]),
    trackedAt: browserSessionTimestampSchema,
    lastUsedAt: browserSessionTimestampSchema,
    dashboard: z
      .object({
        name: z.string().min(1).max(64),
        sessionKey: z.string().min(1),
        instanceId: z.string().min(1),
        agentId: z.string().min(1).optional(),
        url: z.string().min(1).max(4096),
        state: z.enum(["active", "stopping", "stopped", "released"]),
      })
      .optional(),
    cleanupRequestedAt: browserSessionTimestampSchema.optional(),
    cleanupAttemptToken: z.string().min(1).optional(),
    cleanupKind: z.enum(["lifecycle", "sweep"]).optional(),
  })
  .superRefine((record, context) => {
    if (record.profileAliases) {
      const canonical = [...new Set(record.profileAliases)].toSorted(
        compareBrowserSessionTabProfileAliases,
      );
      if (
        canonical.includes(record.profile) ||
        !canonical.every((entry, index) => entry === record.profileAliases?.[index])
      ) {
        context.addIssue({
          code: "custom",
          message: "profile aliases must be sorted, unique, and exclude the primary profile",
        });
      }
    }
    const cleanupFieldCount = [
      record.cleanupRequestedAt,
      record.cleanupAttemptToken,
      record.cleanupKind,
    ].filter((value) => value !== undefined).length;
    if (cleanupFieldCount !== 0 && cleanupFieldCount !== 3) {
      context.addIssue({ code: "custom", message: "cleanup fields must be all present or absent" });
    }
    if (Object.hasOwn(record, "baseUrl") || Object.hasOwn(record, "interactionTargetId")) {
      context.addIssue({ code: "custom", message: "retired browser tab fields are not allowed" });
    }
  });

export type BrowserSessionTabRecord = z.infer<typeof browserSessionTabRecordSchema>;
export type BrowserDashboardStopIntent = z.infer<typeof browserDashboardStopIntentSchema>;

function browserDashboardStopIntentKey(
  identity: Pick<BrowserDashboardIdentity, "sessionKey" | "agentId" | "instanceId" | "name">,
): string {
  return `dashboard-stop:${createHash("sha256")
    .update(
      JSON.stringify([identity.sessionKey, identity.agentId, identity.instanceId, identity.name]),
    )
    .digest("hex")}`;
}

export function parseBrowserDashboardStopIntent(
  key: string,
  value: unknown,
): BrowserDashboardStopIntent | undefined {
  const parsed = browserDashboardStopIntentSchema.safeParse(value);
  return parsed.success && browserDashboardStopIntentKey(parsed.data) === key
    ? parsed.data
    : undefined;
}

export async function readBrowserDashboardStopIntent(
  identity: BrowserDashboardIdentity,
  authority: BrowserSessionTabAuthority = {},
) {
  const key = browserDashboardStopIntentKey(identity);
  return parseBrowserDashboardStopIntent(
    key,
    await getOptionalBrowserSessionTabStore(authority)?.lookup(key),
  );
}

export async function readBrowserDashboardStopIntents(
  authority: BrowserSessionTabAuthority = {},
): Promise<BrowserDashboardStopIntent[]> {
  return ((await getOptionalBrowserSessionTabStore(authority)?.entries()) ?? []).flatMap(
    ({ key, value }) => {
      const intent = parseBrowserDashboardStopIntent(key, value);
      return intent ? [intent] : [];
    },
  );
}

export async function persistBrowserDashboardStopIntent(
  identity: BrowserDashboardIdentity,
  authority: BrowserSessionTabAuthority = {},
): Promise<void> {
  const { sessionKey, agentId, name, instanceId, url, profile } = identity;
  const intent: BrowserDashboardStopIntent = {
    kind: "dashboard-stop",
    version: 1,
    stopId: randomUUID(),
    sessionKey,
    agentId,
    name,
    instanceId,
    url,
    profile,
  };
  await withBrowserSessionTabOperation(
    browserDashboardStopIntentKey(intent),
    authority,
    async (store) => {
      await store.register(browserDashboardStopIntentKey(intent), intent);
    },
  );
}

export async function deleteBrowserDashboardStopIntent(
  intent: BrowserDashboardStopIntent,
  authority: BrowserSessionTabAuthority = {},
): Promise<boolean> {
  const key = browserDashboardStopIntentKey(intent);
  return deleteBrowserSessionTabIf(
    key,
    (current) => parseBrowserDashboardStopIntent(key, current)?.stopId === intent.stopId,
    authority,
  );
}

type BrowserSessionTabStoreRuntime = {
  state: Pick<PluginRuntime["state"], "openKeyedStore">;
  gateway?: PluginRuntime["gateway"];
};

/** Opens and publishes Browser's canonical durable tab store during plugin registration. */
export function initializeBrowserSessionTabStore(runtime: BrowserSessionTabStoreRuntime) {
  const state: ReturnType<typeof getBrowserStateRuntime> = {
    sessionTabs: runtime.state.openKeyedStore<unknown>({
      namespace: BROWSER_SESSION_TABS_NAMESPACE,
      maxEntries: BROWSER_SESSION_TABS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    sessionTabOperations: new Map(),
    // Metadata registration must not materialize the broad host runtime.
    get gateway() {
      return runtime.gateway;
    },
    dashboardOperations: new Map(),
  };
  setBrowserStateRuntime(state);
  resetDurableTabAliases();
  return state;
}

export async function ensureBrowserSessionTabStoreReady(
  runtime = getOptionalBrowserStateRuntime(),
): Promise<void> {
  if (!runtime) {
    return;
  }
  const initialization = (runtime.sessionTabInitialization ??= (async () => {
    const entries = await getBrowserSessionTabStore({ runtime }).entries();
    assertBrowserSessionTabAuthority({ runtime });
    for (const entry of entries) {
      const record = parseBrowserSessionTabRecord(entry.value);
      if (!record || browserSessionTabStorageKey(record) !== entry.key) {
        continue;
      }
      rememberDurableTabAliases(
        {
          sessionKey: record.sessionKey,
          targetId: record.nativeTargetId,
          profile: record.profile,
        },
        [],
        entry.key,
        record.profileAliases,
      );
    }
  })());
  try {
    await initialization;
  } catch (error) {
    if (runtime.sessionTabInitialization === initialization) {
      runtime.sessionTabInitialization = undefined;
    }
    throw error;
  }
  assertBrowserSessionTabAuthority({ runtime });
}

export async function drainBrowserSessionTabStore(runtime: BrowserStateRuntime): Promise<void> {
  await runtime.sessionTabInitialization?.catch(() => {});
  while (runtime.sessionTabOperations.size > 0 || runtime.dashboardOperations.size > 0) {
    await Promise.allSettled([
      ...runtime.sessionTabOperations.values(),
      ...[...runtime.dashboardOperations.values()].map(({ promise }) => promise),
    ]);
  }
}

export function getBrowserSessionTabStore(
  authority: BrowserSessionTabAuthority = {},
): PluginStateKeyedStore<unknown, 2> {
  const runtime = authority.runtime ?? getBrowserStateRuntime();
  const withCurrent = runtime.sessionTabs.withCurrent;
  if (!withCurrent) {
    throw new Error("Browser session tab store requires worker comparison support");
  }
  return withCurrent({
    assertCurrent: () => assertBrowserSessionTabAuthority({ ...authority, runtime }),
    sessionEntryCurrent: authority.sessionEntryCurrent,
  });
}

export function getOptionalBrowserSessionTabStore(
  authority: BrowserSessionTabAuthority = {},
): PluginStateKeyedStore<unknown, 2> | undefined {
  return authority.runtime || getOptionalBrowserStateRuntime()
    ? getBrowserSessionTabStore(authority)
    : undefined;
}

export async function withBrowserSessionTabOperation<T>(
  keys: BrowserSessionTabOperationKey | string[],
  authority: BrowserSessionTabAuthority,
  operation: (store: ReturnType<typeof getBrowserSessionTabStore>) => Promise<T>,
  dependencies: Promise<void>[] = [],
): Promise<T> {
  const runtime = authority.runtime ?? getBrowserStateRuntime();
  const store = getBrowserSessionTabStore({ ...authority, runtime });
  const selected = Array.isArray(keys) ? [...new Set(keys)] : [keys];
  const previous = selected.flatMap((key) => runtime.sessionTabOperations.get(key) ?? []);
  const pending = Promise.all([...previous, ...dependencies]).then(async () => {
    assertBrowserSessionTabAuthority({ ...authority, runtime });
    return await operation(store);
  });
  const settled = pending.then(
    () => {},
    () => {},
  );
  for (const key of selected) {
    runtime.sessionTabOperations.set(key, settled);
  }
  try {
    return await pending;
  } finally {
    for (const key of selected) {
      if (runtime.sessionTabOperations.get(key) === settled) {
        runtime.sessionTabOperations.delete(key);
      }
    }
  }
}

/** Hold same-process mutation admission through the fresh read and synchronous effect dispatch. */
export async function dispatchBrowserSessionTabIfCurrent<T>(
  key: string,
  predicate: (current: unknown) => boolean,
  dispatch: () => Promise<T>,
  authority: BrowserSessionTabAuthority = {},
): Promise<T | undefined> {
  const captured = { ...authority, runtime: authority.runtime ?? getBrowserStateRuntime() };
  const dispatched = await withBrowserSessionTabOperation(key, captured, async (store) => {
    if (!predicate(await store.lookup(key))) {
      return undefined;
    }
    assertBrowserSessionTabAuthority(captured);
    // Do not retain admission while the network response is pending.
    return { result: dispatch() };
  });
  return await dispatched?.result;
}

export async function readBrowserDashboardTabs(
  storageKey?: string,
  authority: BrowserSessionTabAuthority = {},
): Promise<Array<BrowserSessionTabRecord & { storageKey: string }>> {
  const store = getOptionalBrowserSessionTabStore(authority);
  const entries =
    storageKey === undefined
      ? ((await store?.entries()) ?? [])
      : [{ key: storageKey, value: await store?.lookup(storageKey) }];
  return entries.flatMap(({ key, value }) => {
    const tab = parseBrowserDashboardTab(key, value);
    return tab ? [tab] : [];
  });
}

function parseBrowserDashboardTab(key: string, value: unknown) {
  const record = parseBrowserSessionTabRecord(value);
  return record?.dashboard && browserSessionTabStorageKey(record) === key
    ? { ...record, storageKey: key }
    : undefined;
}

/** Discovery only; reconciliation rereads current authority after awaited work. */
export async function readBrowserDashboardSessionOwners(): Promise<
  Array<{
    sessionKey: string;
    agentId?: string;
  }>
> {
  const entries = (await getOptionalBrowserSessionTabStore()?.entries()) ?? [];
  const dashboards = entries.flatMap(({ key, value }) => {
    const tab = parseBrowserDashboardTab(key, value);
    return tab?.dashboard ? [tab.dashboard] : [];
  });
  const stopIntents = entries.flatMap(({ key, value }) => {
    const intent = parseBrowserDashboardStopIntent(key, value);
    return intent ? [intent] : [];
  });
  return [...dashboards, ...stopIntents];
}

/** Ordinary close commands cannot discard a dashboard's retained page. */
export function findRetainedBrowserDashboardTab(
  targetId: string,
  profile: string | undefined,
  tabs: Array<BrowserSessionTabRecord & { storageKey: string }>,
) {
  return tabs.find(
    (tab) =>
      tab.nativeTargetId === targetId &&
      (!profile || tab.profile === profile) &&
      (tab.dashboard?.state === "active" || tab.dashboard?.state === "stopping"),
  );
}

const dashboardTargetLane = "dashboard-target:";
const unidentifiedDashboardCloseLane = "dashboard-close:unidentified";

function withDashboardTabAdmission<T>(
  targets: string[] | undefined,
  authority: BrowserSessionTabAuthority,
  operation: (store: ReturnType<typeof getBrowserSessionTabStore>) => Promise<T>,
): Promise<T> {
  const runtime = authority.runtime ?? getBrowserStateRuntime();
  const operations = runtime.sessionTabOperations;
  // An unidentified close joins existing target admissions. Later mutations join
  // that close; target keys are reserved together so neither side can wait on itself.
  const dependencies = targets
    ? [operations.get(unidentifiedDashboardCloseLane)].filter((entry) => entry !== undefined)
    : [...operations].flatMap(([key, pending]) =>
        typeof key === "string" && key.startsWith(dashboardTargetLane) ? [pending] : [],
      );
  return withBrowserSessionTabOperation(
    targets
      ? targets.map((target) => `${dashboardTargetLane}${target}`)
      : unidentifiedDashboardCloseLane,
    { ...authority, runtime },
    operation,
    dependencies,
  );
}

export async function dispatchBrowserTabClose<T>(
  targetId: string | undefined,
  profile: string | undefined,
  dispatch: () => Promise<T>,
  options: { skipRetained?: boolean; assertCurrent?: () => void | Promise<void> } = {},
): Promise<T | undefined> {
  const runtime = getOptionalBrowserStateRuntime();
  if (!runtime) {
    const assertion = options.assertCurrent?.();
    if (assertion) {
      await assertion;
    }
    return await dispatch();
  }
  // Join earlier registration preparation before reserving any close lane;
  // registration still acquires storage, native identity, and target in order.
  const registrations = getPendingBrowserDashboardRegistrations(runtime, targetId, profile);
  if (registrations.length > 0) {
    await Promise.all(registrations.map(({ settled }) => settled));
  }
  const admitted = await withDashboardTabAdmission(
    targetId ? [targetId] : undefined,
    { runtime },
    async (store) => {
      const tabs = (await store.entries()).flatMap(({ key, value }) => {
        const tab = parseBrowserDashboardTab(key, value);
        return tab ? [tab] : [];
      });
      assertBrowserSessionTabAuthority({ runtime });
      if (!targetId && tabs.length > 0) {
        throw new Error("Cannot verify that this page is not retained by a dashboard");
      }
      const retained = targetId
        ? findRetainedBrowserDashboardTab(targetId, profile, tabs)
        : undefined;
      if (retained && options.skipRetained) {
        return undefined;
      }
      if (retained) {
        throw new Error(
          `This tab belongs to dashboard ${retained.dashboard!.name}. Stop it from the dashboard or use browser action=close dashboard=${retained.dashboard!.name}.`,
        );
      }
      const assertion = options.assertCurrent?.();
      if (assertion) {
        await assertion;
      }
      assertBrowserSessionTabAuthority({ runtime });
      const pending = getPendingBrowserDashboardRegistrations(runtime, targetId, profile);
      for (const { registration } of pending) {
        registration.closeDispatched = true;
      }
      return { result: dispatch() };
    },
  );
  return await admitted?.result;
}

export function compareBrowserSessionTabProfileAliases(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseBrowserSessionTabRecord(value: unknown): BrowserSessionTabRecord | undefined {
  const parsed = browserSessionTabRecordSchema.safeParse(value);
  return parsed.success &&
    resolveBrowserSessionKey(parsed.data.sessionKey) === parsed.data.sessionKey
    ? parsed.data
    : undefined;
}

export function sameBrowserSessionTabRecord(
  left: BrowserSessionTabRecord,
  right: BrowserSessionTabRecord,
): boolean {
  return (
    left.version === right.version &&
    left.sessionKey === right.sessionKey &&
    left.nativeTargetId === right.nativeTargetId &&
    left.profile === right.profile &&
    (left.profileAliases?.length ?? 0) === (right.profileAliases?.length ?? 0) &&
    (left.profileAliases ?? []).every((alias, index) => alias === right.profileAliases?.[index]) &&
    left.profileFingerprint === right.profileFingerprint &&
    left.browserInstanceFingerprint === right.browserInstanceFingerprint &&
    left.interactionTargetKind === right.interactionTargetKind &&
    left.trackedAt === right.trackedAt &&
    left.lastUsedAt === right.lastUsedAt &&
    left.dashboard?.name === right.dashboard?.name &&
    left.dashboard?.sessionKey === right.dashboard?.sessionKey &&
    left.dashboard?.instanceId === right.dashboard?.instanceId &&
    left.dashboard?.agentId === right.dashboard?.agentId &&
    left.dashboard?.url === right.dashboard?.url &&
    left.dashboard?.state === right.dashboard?.state &&
    left.cleanupRequestedAt === right.cleanupRequestedAt &&
    left.cleanupAttemptToken === right.cleanupAttemptToken &&
    left.cleanupKind === right.cleanupKind
  );
}

export function withoutBrowserSessionTabCleanup(
  record: BrowserSessionTabRecord,
): BrowserSessionTabRecord {
  const active = { ...record };
  delete active.cleanupRequestedAt;
  delete active.cleanupAttemptToken;
  delete active.cleanupKind;
  return active;
}

async function retireColdNativeActivityIfUnowned(
  store: ReturnType<typeof getBrowserSessionTabStore>,
  identity: string | undefined,
  authority: BrowserSessionTabAuthority,
): Promise<void> {
  if (!identity || readColdNativeActivity(identity) === undefined) {
    return;
  }
  // Only observed cold identities need a scan of the bounded canonical store.
  // Retained dashboard rows and sibling generations still own their activity.
  const entries = await store.entries().catch((error: unknown) => {
    // This read follows an accepted mutation. Preserve conservative activity on
    // failure without turning the committed write into a retry or compensation.
    logger.warn(`Could not retire Browser tab activity: ${String(error)}`);
    return undefined;
  });
  if (!entries) {
    return;
  }
  const hasOwner = entries.some(({ key, value }) => {
    const record = parseBrowserSessionTabRecord(value);
    return (
      record?.interactionTargetKind === "native" &&
      browserSessionTabNativeIdentity(record) === identity &&
      browserSessionTabStorageKey(record) === key
    );
  });
  if (!hasOwner && getOptionalBrowserStateRuntime() === authority.runtime) {
    forgetColdNativeActivity(identity);
  }
}

type BrowserSessionTabUpdate = (current: unknown) => BrowserSessionTabRecord | undefined;
type BrowserSessionTabMutation =
  | { operation: "update"; update: BrowserSessionTabUpdate }
  | { operation: "delete"; predicate: (current: unknown) => boolean };
type BrowserSessionTabWriteOptions = BrowserSessionTabAuthority & {
  onCommitted?: (record: BrowserSessionTabRecord) => void;
};

export type BrowserSessionTabSelection = {
  lookup: () => Promise<unknown>;
  update: (
    update: BrowserSessionTabUpdate,
    onCommitted?: (record: BrowserSessionTabRecord) => void,
  ) => Promise<BrowserSessionTabRecord | undefined>;
  deleteIf: (predicate: (current: unknown) => boolean) => Promise<boolean>;
};

export async function withBrowserSessionTabSelection<T>(
  key: string,
  authority: BrowserSessionTabAuthority,
  select: (tab: BrowserSessionTabSelection) => Promise<T>,
): Promise<T> {
  const captured = { ...authority, runtime: authority.runtime ?? getBrowserStateRuntime() };
  return await withBrowserSessionTabOperation(key, captured, async (store) => {
    const mutate = (
      mutation: BrowserSessionTabMutation,
      options: BrowserSessionTabWriteOptions = captured,
    ) => mutateBrowserSessionTabInOperation(store, key, mutation, options);
    return await select({
      lookup: () => store.lookup(key),
      update: async (update, onCommitted) =>
        (await mutate({ operation: "update", update }, { ...captured, onCommitted })).next,
      deleteIf: async (predicate) => (await mutate({ operation: "delete", predicate })).deleted,
    });
  });
}

export async function updateBrowserSessionTab(
  key: string,
  update: BrowserSessionTabUpdate,
  authority: BrowserSessionTabWriteOptions = {},
): Promise<BrowserSessionTabRecord | undefined> {
  return await withBrowserSessionTabSelection(key, authority, (tab) =>
    tab.update(update, authority.onCommitted),
  );
}

export async function deleteBrowserSessionTabIf(
  key: string,
  predicate: (current: unknown) => boolean,
  authority: BrowserSessionTabAuthority = {},
): Promise<boolean> {
  return await withBrowserSessionTabSelection(key, authority, (tab) => tab.deleteIf(predicate));
}

export async function withBrowserSessionTabNativeActivity<T>(
  identity: string,
  authority: BrowserSessionTabAuthority,
  operation: (store: ReturnType<typeof getBrowserSessionTabStore>) => Promise<T>,
): Promise<T> {
  return await withBrowserSessionTabOperation(`native:${identity}`, authority, operation);
}

async function withBrowserSessionTabNativeIdentities<T>(
  records: Array<BrowserSessionTabRecord | undefined>,
  authority: BrowserSessionTabAuthority,
  operation: () => Promise<T>,
): Promise<T> {
  const dashboardTargets = records.flatMap((record) =>
    record?.dashboard ? [record.nativeTargetId] : [],
  );
  const runOperation = () =>
    dashboardTargets.length > 0
      ? withDashboardTabAdmission(dashboardTargets, authority, operation)
      : operation();
  const identities = [
    ...new Set(
      records.flatMap((record) =>
        record?.interactionTargetKind === "native" ? [browserSessionTabNativeIdentity(record)] : [],
      ),
    ),
  ].toSorted();
  const run = async (index: number): Promise<T> => {
    const identity = identities[index];
    return identity === undefined
      ? await runOperation()
      : await withBrowserSessionTabNativeActivity(identity, authority, () => run(index + 1));
  };
  return await run(0);
}

async function mutateBrowserSessionTabInOperation(
  store: ReturnType<typeof getBrowserSessionTabStore>,
  key: string,
  mutation: BrowserSessionTabMutation,
  authority: BrowserSessionTabWriteOptions,
): Promise<{ next: BrowserSessionTabRecord | undefined; deleted: boolean }> {
  let observed = await store.observe(key);
  while (true) {
    const next = mutation.operation === "update" ? mutation.update(observed.value) : undefined;
    const deleted =
      mutation.operation === "delete" &&
      observed.value !== undefined &&
      mutation.predicate(observed.value);
    const previous = parseBrowserSessionTabRecord(observed.value);
    const outcome = await withBrowserSessionTabNativeIdentities(
      [previous, next],
      authority,
      async () => {
        const result = await store.compareAndApply(
          key,
          observed.comparison,
          mutation.operation === "delete"
            ? { operation: "delete", action: deleted ? "delete" : "keep" }
            : next
              ? { operation: "update", action: "set", value: next }
              : { operation: "update", action: "keep" },
        );
        if (
          result.status === "conflict" ||
          (!next && !deleted) ||
          getOptionalBrowserStateRuntime() !== authority.runtime
        ) {
          return result;
        }
        if (next) {
          authority.onCommitted?.(next);
        } else {
          clearDurableTabAliases(key);
          activeDurableStorageKeys().delete(key);
        }
        if (
          deleted ||
          (previous?.interactionTargetKind === "native" &&
            (next?.interactionTargetKind !== "native" ||
              browserSessionTabNativeIdentity(previous) !== browserSessionTabNativeIdentity(next)))
        ) {
          await retireColdNativeActivityIfUnowned(
            store,
            previous?.interactionTargetKind === "native"
              ? browserSessionTabNativeIdentity(previous)
              : undefined,
            authority,
          );
        }
        return result;
      },
    );
    if (outcome.status === "conflict") {
      observed = outcome.current;
      continue;
    }
    return { next, deleted };
  }
}
