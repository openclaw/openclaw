import type {
  CopilotArchiveEntry,
  CopilotPanelBindingRegistry,
  CopilotSessionRegistry,
} from "./copilot-session-registry.js";

type SidePanelContext = {
  contextType: string;
  documentId?: string;
  documentUrl: string;
};

type SidePanelPort = {
  sender?: { documentId?: string; url?: string };
};

export function resolveSidePanelTabId(
  chromeApi: {
    runtime: {
      id: string;
      getContexts(filter: { contextTypes: string[] }): Promise<SidePanelContext[]>;
    };
  },
  port: SidePanelPort,
  panelBindings: Pick<CopilotPanelBindingRegistry, "resolve">,
): Promise<number>;

export function archiveCopilotSession(
  gateway: {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  },
  entry: CopilotArchiveEntry,
): Promise<void>;

export function createCopilotController(options: Record<string, unknown>): {
  initialize(): Promise<void>;
  preparePanel(tabId: number): Promise<{ path: string }>;
  onConsentChanged(): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  refreshConfig(): Promise<void>;
  drainAborts(gatewayScope?: string | null): Promise<void>;
  drainArchives(gatewayScope?: string | null): Promise<void>;
  registry: CopilotSessionRegistry;
};
