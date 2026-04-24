export type BrowserTransport = "cdp" | "chrome-mcp";

export type BrowserTab = {
  targetId: string;
  /** Stable, human-friendly tab handle for this profile runtime (for example t1). */
  tabId?: string;
  /** Optional user-assigned tab label. */
  label?: string;
  title: string;
  url: string;
  wsUrl?: string;
  type?: string;
};

export type SnapshotAriaNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
};
