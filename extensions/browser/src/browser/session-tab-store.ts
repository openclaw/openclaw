import { createHash, randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { z } from "zod";
import type { BrowserDashboardIdentity } from "../browser-dashboard.types.js";
import {
  getBrowserStateRuntime,
  getOptionalBrowserStateRuntime,
  setBrowserStateRuntime,
} from "../browser-runtime-state.js";
import {
  rememberDurableTabAliases,
  resetDurableTabAliases,
} from "./session-tab-ephemeral-aliases.js";

const BROWSER_SESSION_TABS_NAMESPACE = "browser.session-tabs";
const BROWSER_SESSION_TABS_MAX_ENTRIES = 5_000;

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
        context.addIssue({ code: "custom", message: "profile aliases must be canonical" });
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

export function readBrowserDashboardStopIntent(identity: BrowserDashboardIdentity) {
  const key = browserDashboardStopIntentKey(identity);
  return parseBrowserDashboardStopIntent(key, getOptionalBrowserSessionTabStore()?.lookup(key));
}

export function readBrowserDashboardStopIntents(): BrowserDashboardStopIntent[] {
  return (getOptionalBrowserSessionTabStore()?.entries() ?? []).flatMap(({ key, value }) => {
    const intent = parseBrowserDashboardStopIntent(key, value);
    return intent ? [intent] : [];
  });
}

export function persistBrowserDashboardStopIntent(identity: BrowserDashboardIdentity): void {
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
  getBrowserSessionTabStore().register(browserDashboardStopIntentKey(intent), intent);
}

export function deleteBrowserDashboardStopIntent(intent: BrowserDashboardStopIntent): boolean {
  const key = browserDashboardStopIntentKey(intent);
  return deleteBrowserSessionTabIf(
    key,
    (current) => parseBrowserDashboardStopIntent(key, current)?.stopId === intent.stopId,
  );
}

type BrowserSessionTabStoreRuntime = {
  state: Pick<PluginRuntime["state"], "openSyncKeyedStore">;
  gateway?: PluginRuntime["gateway"];
};

/** Opens and publishes Browser's canonical durable tab store during plugin registration. */
export function initializeBrowserSessionTabStore(runtime: BrowserSessionTabStoreRuntime): void {
  const sessionTabs = runtime.state.openSyncKeyedStore<unknown>({
    namespace: BROWSER_SESSION_TABS_NAMESPACE,
    maxEntries: BROWSER_SESSION_TABS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  setBrowserStateRuntime({
    sessionTabs,
    // Metadata registration must not materialize the broad host runtime.
    get gateway() {
      return runtime.gateway;
    },
    dashboardOperations: new Map(),
  });
  resetDurableTabAliases();
  for (const entry of sessionTabs.entries()) {
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
}

export function getBrowserSessionTabStore() {
  return getBrowserStateRuntime().sessionTabs;
}

export function getOptionalBrowserSessionTabStore() {
  return getOptionalBrowserStateRuntime()?.sessionTabs;
}

export function readBrowserDashboardTabs(
  storageKey?: string,
): Array<BrowserSessionTabRecord & { storageKey: string }> {
  const store = getOptionalBrowserSessionTabStore();
  const entries =
    storageKey === undefined
      ? (store?.entries() ?? [])
      : [{ key: storageKey, value: store?.lookup(storageKey) }];
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
export function readBrowserDashboardSessionOwners(): Array<{
  sessionKey: string;
  agentId?: string;
}> {
  const entries = getOptionalBrowserSessionTabStore()?.entries() ?? [];
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
  profile?: string,
  tabs = readBrowserDashboardTabs(),
) {
  return tabs.find(
    (tab) =>
      tab.nativeTargetId === targetId &&
      (!profile || tab.profile === profile) &&
      (tab.dashboard?.state === "active" || tab.dashboard?.state === "stopping"),
  );
}

export function assertBrowserDashboardTabCanClose(targetId: string, profile?: string): void {
  const retained = findRetainedBrowserDashboardTab(targetId, profile);
  if (retained) {
    throw new Error(
      `This tab belongs to dashboard ${retained.dashboard!.name}. Stop it from the dashboard or use browser action=close dashboard=${retained.dashboard!.name}.`,
    );
  }
}

export function browserSessionTabStorageKey(record: {
  sessionKey: string;
  nativeTargetId: string;
  profileFingerprint: string;
  browserInstanceFingerprint: string;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        record.sessionKey,
        record.nativeTargetId,
        record.profileFingerprint,
        record.browserInstanceFingerprint,
      ]),
    )
    .digest("hex")}`;
}

export function browserSessionTabNativeIdentity(
  record: Pick<BrowserSessionTabRecord, "sessionKey" | "profile" | "nativeTargetId">,
): string {
  return `${record.sessionKey}\u0000${record.profile}\u0000${record.nativeTargetId}`;
}

export function compareBrowserSessionTabProfileAliases(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseBrowserSessionTabRecord(value: unknown): BrowserSessionTabRecord | undefined {
  const parsed = browserSessionTabRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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

export function updateBrowserSessionTab(
  key: string,
  update: (current: unknown) => BrowserSessionTabRecord | undefined,
): boolean {
  const updateStore = getBrowserSessionTabStore().update;
  if (!updateStore) {
    throw new Error("Browser session tab store requires atomic update support");
  }
  return updateStore(key, update);
}

export function deleteBrowserSessionTabIf(
  key: string,
  predicate: (current: unknown) => boolean,
): boolean {
  const deleteIf = getBrowserSessionTabStore().deleteIf;
  if (!deleteIf) {
    throw new Error("Browser session tab store requires atomic deleteIf support");
  }
  return deleteIf(key, predicate);
}
