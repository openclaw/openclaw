import type { BrowserTabSnapshot } from "./tab-eligibility.js";

type StorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<unknown>;
  remove(keys: string[]): Promise<unknown>;
};

type CreatedTabOperation = {
  tab: BrowserTabSnapshot;
  assertCurrent(): void;
};

export type SelectedTabsController = {
  add(tabId: number, created?: CreatedTabOperation): Promise<void>;
  has(tabId: number): Promise<boolean>;
  isExplicit(): Promise<boolean>;
  isSelected(tab: BrowserTabSnapshot | null | undefined): Promise<boolean>;
  remove(tabId: number): Promise<void>;
  replaceTab(addedTabId: number, removedTabId: number): Promise<boolean>;
  replaceWith(tabId: number): Promise<void>;
  reset(): Promise<void>;
};

export function createSelectedTabsController(options: {
  chromeApi?: {
    storage: { local: StorageArea; session: StorageArea };
    tabs: {
      get(tabId: number): Promise<BrowserTabSnapshot>;
      ungroup(tabIds: number[]): Promise<unknown>;
    };
  };
  getGroupColor?: () => string | Promise<string>;
}): SelectedTabsController;
