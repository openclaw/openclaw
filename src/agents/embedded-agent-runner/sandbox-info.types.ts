export type EmbeddedFullAccessBlockedReason = "sandbox" | "host-policy" | "channel" | "runtime";

export type EmbeddedSandboxInfo = {
  enabled: boolean;
  workspaceDir?: string;
  containerWorkspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  agentWorkspaceMount?: string;
  browserBridgeUrl?: string;
  hostBrowserAllowed?: boolean;
  elevated?: {
    allowed: boolean;
    defaultLevel: "on" | "off" | "ask" | "full";
    fullAccessAvailable: boolean;
    fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
  };
};
