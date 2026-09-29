import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { BrowserDashboardDefinition } from "./browser-dashboard.types.js";
import type { BrowserSessionTabAuthority } from "./browser-runtime-state.js";
import { closeBrowserDashboardTabs } from "./browser/session-tab-registry.js";
import {
  deleteBrowserSessionTabIf,
  parseBrowserSessionTabRecord,
  readBrowserDashboardTabs,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
  withoutBrowserSessionTabCleanup,
  type BrowserSessionTabRecord,
} from "./browser/session-tab-store.js";

export type DashboardTab = BrowserSessionTabRecord & { storageKey: string };
const logger = createSubsystemLogger("browser");

export function emitDashboardChanged(
  definition: BrowserDashboardDefinition,
  authority: BrowserSessionTabAuthority,
): void {
  try {
    authority.runtime?.dashboardEvents?.emit(
      "dashboard_changed",
      {
        sessionKey: definition.sessionKey,
        name: definition.name,
        instanceId: definition.instanceId,
      },
      { scope: "operator.admin" },
    );
  } catch (error) {
    logger.warn(`Browser dashboard invalidation unavailable: ${String(error)}`);
  }
}

export async function tabsForDefinition(
  definition: BrowserDashboardDefinition,
  authority: BrowserSessionTabAuthority,
  storageKey?: string,
): Promise<DashboardTab[]> {
  return (await readBrowserDashboardTabs(storageKey, authority))
    .filter(
      (tab) =>
        tab.dashboard?.sessionKey === definition.sessionKey &&
        tab.dashboard?.instanceId === definition.instanceId &&
        tab.dashboard?.agentId === definition.agentId &&
        tab.dashboard?.name === definition.name,
    )
    .toSorted(
      (left, right) =>
        Number(right.dashboard?.state === "active") - Number(left.dashboard?.state === "active"),
    );
}

export function definitionOwnsTab(
  definition: BrowserDashboardDefinition | undefined,
  tab: DashboardTab,
): boolean {
  return Boolean(
    definition &&
    definition.profile === tab.profile &&
    definition.url === tab.dashboard?.url &&
    definition.instanceId === tab.dashboard?.instanceId &&
    definition.sessionKey === tab.dashboard?.sessionKey,
  );
}

export async function changeTabState(
  tab: DashboardTab,
  state: NonNullable<BrowserSessionTabRecord["dashboard"]>["state"],
  authority: BrowserSessionTabAuthority,
): Promise<DashboardTab | undefined> {
  const updated = await updateBrowserSessionTab(
    tab.storageKey,
    (raw) => {
      const current = parseBrowserSessionTabRecord(raw);
      if (!current?.dashboard || !sameBrowserSessionTabRecord(current, tab)) {
        return undefined;
      }
      return {
        ...withoutBrowserSessionTabCleanup(current),
        dashboard: { ...current.dashboard, state },
      };
    },
    authority,
  );
  return updated ? { ...updated, storageKey: tab.storageKey } : undefined;
}

export async function deleteStoppedTab(
  tab: DashboardTab,
  authority: BrowserSessionTabAuthority,
): Promise<boolean> {
  return await deleteBrowserSessionTabIf(
    tab.storageKey,
    (raw) => {
      const current = parseBrowserSessionTabRecord(raw);
      return Boolean(current && sameBrowserSessionTabRecord(current, tab));
    },
    authority,
  );
}

export async function releaseTab(
  tab: DashboardTab,
  authority: BrowserSessionTabAuthority,
  params: Parameters<typeof closeBrowserDashboardTabs>[1] = {},
): Promise<{ released: boolean; closed: number }> {
  if (tab.dashboard?.state === "stopped") {
    return { released: await deleteStoppedTab(tab, authority), closed: 0 };
  }
  const released =
    tab.dashboard?.state === "released" ? tab : await changeTabState(tab, "released", authority);
  const closed = released
    ? await closeBrowserDashboardTabs([released], { ...params, authority })
    : 0;
  return {
    released:
      (await readBrowserDashboardTabs(tab.storageKey, { runtime: authority.runtime })).length === 0,
    closed,
  };
}

export async function closeStoppingTab(
  tab: DashboardTab,
  definition: BrowserDashboardDefinition,
  authority: BrowserSessionTabAuthority,
  params: Parameters<typeof closeBrowserDashboardTabs>[1] = {},
): Promise<number> {
  const closed = await closeBrowserDashboardTabs([tab], { ...params, authority });
  if (
    (await readBrowserDashboardTabs(tab.storageKey, { runtime: authority.runtime })).some(
      (current) => current.dashboard?.state === "stopped",
    )
  ) {
    emitDashboardChanged(definition, authority);
  }
  return closed;
}
