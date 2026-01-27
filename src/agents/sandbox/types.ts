import type { SandboxDockerConfig } from "./types.docker.js";
import type { AnchorBrowserSettings, SandboxBrowserProvider } from "../../config/types.sandbox.js";

export type { SandboxDockerConfig } from "./types.docker.js";
export type { AnchorBrowserSettings, SandboxBrowserProvider } from "../../config/types.sandbox.js";

export type SandboxToolPolicy = {
  allow?: string[];
  deny?: string[];
};

export type SandboxToolPolicySource = {
  source: "agent" | "global" | "default";
  /**
   * Config key path hint for humans.
   * (Arrays use `agents.list[].…` form.)
   */
  key: string;
};

export type SandboxToolPolicyResolved = {
  allow: string[];
  deny: string[];
  sources: {
    allow: SandboxToolPolicySource;
    deny: SandboxToolPolicySource;
  };
};

export type SandboxWorkspaceAccess = "none" | "ro" | "rw";

export type SandboxBrowserConfig = {
  enabled: boolean;
  /** Browser provider: "docker" (default) or "anchorbrowser". */
  provider: SandboxBrowserProvider;

  // Docker-specific settings
  image: string;
  containerPrefix: string;
  cdpPort: number;
  vncPort: number;
  noVncPort: number;
  enableNoVnc: boolean;

  // Anchorbrowser-specific settings
  anchorbrowser?: AnchorBrowserSettings;

  // Common settings
  headless: boolean;
  allowHostControl: boolean;
  autoStart: boolean;
  autoStartTimeoutMs: number;
};

export type SandboxPruneConfig = {
  idleHours: number;
  maxAgeDays: number;
};

export type SandboxScope = "session" | "agent" | "shared";

export type SandboxConfig = {
  mode: "off" | "non-main" | "all";
  scope: SandboxScope;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceRoot: string;
  docker: SandboxDockerConfig;
  browser: SandboxBrowserConfig;
  tools: SandboxToolPolicy;
  prune: SandboxPruneConfig;
};

export type SandboxBrowserContext = {
  bridgeUrl: string;
  /** NoVNC URL for Docker-based browsers. */
  noVncUrl?: string;
  /** Live view URL for Anchorbrowser sessions. */
  liveViewUrl?: string;
  /** Docker container name (Docker provider only). */
  containerName?: string;
  /** Anchorbrowser session ID (Anchorbrowser provider only). */
  sessionId?: string;
};

export type SandboxContext = {
  enabled: boolean;
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  containerName: string;
  containerWorkdir: string;
  docker: SandboxDockerConfig;
  tools: SandboxToolPolicy;
  browserAllowHostControl: boolean;
  browser?: SandboxBrowserContext;
};

export type SandboxWorkspaceInfo = {
  workspaceDir: string;
  containerWorkdir: string;
};
