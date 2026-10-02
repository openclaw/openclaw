import type { BrowserTabSnapshot } from "./tab-eligibility.js";

type TabGroupSnapshot = {
  id: number;
  windowId: number;
  title?: string;
};

type CreatedTabGroupOperation = {
  tab: BrowserTabSnapshot;
  groupId: number;
  expectedGroupId?: number;
  grouping?: boolean;
  initialGroup?: boolean;
  namingGroup?: number;
  assertCurrent(): void;
};

type TabGroupChromeApi = {
  tabs: {
    get(tabId: number): Promise<BrowserTabSnapshot>;
    group(options: { tabIds: number[]; groupId?: number }): Promise<number>;
  };
  tabGroups: {
    query(options: { title: string }): Promise<TabGroupSnapshot[]>;
    update(
      groupId: number,
      options: { title: string; color: string | undefined },
    ): Promise<unknown>;
  };
};

export function isTabSelected(tab: BrowserTabSnapshot | null | undefined): Promise<boolean>;

export function addTabToOpenClawGroup(
  tabId: number,
  options: {
    chromeApi: TabGroupChromeApi;
    getGroupColor(): string | Promise<string>;
    created?: CreatedTabGroupOperation;
  },
): Promise<void>;
