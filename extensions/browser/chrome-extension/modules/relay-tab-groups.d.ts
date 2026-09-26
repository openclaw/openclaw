import type { BrowserTabSnapshot } from "./tab-eligibility.js";

export function isTabSelected(tab?: BrowserTabSnapshot): Promise<boolean>;

type CreatedTab = {
  tab: BrowserTabSnapshot;
  groupId: number;
  grouping: boolean;
  groupFallback: boolean;
  groupFallbackRequiresOpenClawTitle: boolean;
  expectedGroupId?: number;
  groupOperationGroupId?: number;
  pendingGroupId?: number;
  namingGroup?: number;
  revokeCreation?(): void;
  initialGroup: boolean;
  assertCurrent(): void;
};

export function addTabToOpenClawGroup(
  tabId: number,
  options: {
    chromeApi?: typeof chrome;
    getGroupColor(): Promise<string>;
    created?: CreatedTab;
  },
): Promise<void>;
