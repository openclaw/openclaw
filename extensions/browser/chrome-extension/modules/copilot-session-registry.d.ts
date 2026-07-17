import type { BrowserCopilotBinding } from "./panel-core.js";

export type CopilotSessionEntry = {
  tabId: number;
  browserInstanceId: string;
  sessionKey: string;
  sessionId?: string;
  binding?: BrowserCopilotBinding;
  createdAt?: number;
};

export type CopilotArchiveEntry = {
  sessionKey: string;
  sessionId?: string;
  queuedAt: number;
};

export class CopilotPanelBindingRegistry {
  constructor(storage?: unknown);
  initialize(): Promise<void>;
  bind(tabId: number): Promise<string>;
  resolve(token: string): Promise<number | null>;
  remove(tabId: number): Promise<void>;
}

export class CopilotSessionRegistry {
  constructor(storage?: unknown);
  initialize(existingTabIds: Set<number>): Promise<string>;
  get(tabId: number): CopilotSessionEntry | null;
  list(): CopilotSessionEntry[];
  pendingArchives(): CopilotArchiveEntry[];
  put(
    tabId: number,
    entry: Omit<CopilotSessionEntry, "tabId" | "browserInstanceId">,
  ): Promise<CopilotSessionEntry>;
  updateBinding(tabId: number, binding: BrowserCopilotBinding): Promise<void>;
  closeTab(tabId: number): Promise<CopilotSessionEntry | null>;
  resolveArchive(sessionKey: string): Promise<void>;
}
