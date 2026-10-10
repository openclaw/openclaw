import type { CreatedTabOperation, TabAccessEpoch, TabAccessPolicy } from "./tab-access.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

type RequireRelayTab = (
  tabId: number,
  epoch: TabAccessEpoch,
) => ReturnType<TabAccessPolicy["requireTab"]>;

export function createRelayCommandHandler(params: {
  isCurrent: () => boolean;
  send: (message: Record<string, unknown>) => void;
  attachDebugger: CreatedTabOperation["attachDebugger"];
  detachDebugger: (tabId: number) => Promise<void>;
  createTab: (message: Record<string, unknown>, operation: CreatedTabOperation) => Promise<void>;
  focusWindowForTab: (tab: BrowserTabSnapshot) => Promise<void>;
  scheduleTabsSync: () => void;
  captureDebugger: (tabId: number) => () => void;
  captureAccess: (tabId: number, method?: string) => TabAccessEpoch;
  navigateTab: (
    tabId: number,
    epoch: TabAccessEpoch,
    params: Record<string, unknown>,
    isCurrent: () => boolean,
    sendCommand: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<unknown>;
  requireNavigatedTab: RequireRelayTab;
  requireAccessibleTab: RequireRelayTab;
}): (message: Record<string, unknown>) => Promise<void>;
