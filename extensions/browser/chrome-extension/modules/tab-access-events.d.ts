import type { TabAccessEpoch, TabAccessPolicy } from "./tab-access.js";

export type TabAccessEventPolicy = Pick<
  TabAccessPolicy,
  | "mode"
  | "beginRevocation"
  | "endRevocation"
  | "capture"
  | "epochIsCurrent"
  | "invalidateTab"
  | "retireTab"
  | "forwardDocumentEvent"
  | "renewTabAccess"
  | "invalidateGroup"
  | "observeTabUpdate"
  | "forgetTab"
  | "replaceTab"
> & {
  inspectTab(tabId: number, epoch: TabAccessEpoch): Promise<{ accessible: boolean }>;
  listAccessibleTabs(): Promise<Array<{ id: number }>>;
};

export function registerTabAccessEvents(options: {
  accessReady: Promise<unknown>;
  policy: TabAccessEventPolicy;
  attachments: Map<
    number,
    { epoch?: TabAccessEpoch; pending?: Promise<unknown>; retired?: boolean }
  >;
  nativeDetached(tabId: number): void;
  send(message: Record<string, unknown>): void;
  scheduleTabsSync(): void;
  detachDebugger(tabId: number): Promise<void>;
  pauseTab(tabId: number): void | Promise<void>;
  removeTabFromOpenClawGroup(tabId: number): void | Promise<void>;
  runAccessMutation(task: () => void | Promise<void>): Promise<void>;
}): void;
