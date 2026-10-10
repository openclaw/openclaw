import type { SchemaContract } from "../../../packages/gateway-protocol/src/schema-contract.js";
import type { AgentSandboxConfig } from "../../config/types.agents-shared.js";
import type { SkillEligibilityContext, SkillUsagePath } from "../../skills/types.js";
import type { SandboxBackendHandle, SandboxBackendId } from "./backend-handle.types.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";
import type { SandboxDockerConfig } from "./types.docker.js";

export type { SandboxDockerConfig } from "./types.docker.js";

/** In-process provenance, bound to the original resolved allowlist; never serialized. */
export const SANDBOX_DEFAULT_TOOL_ALLOW = Symbol.for("openclaw.sandbox.defaultToolAllow");

export type SandboxToolPolicy = {
  [SANDBOX_DEFAULT_TOOL_ALLOW]?: readonly string[];
  allow?: string[];
  deny?: string[];
};

export type SandboxToolPolicySource = {
  source: "agent" | "global" | "default";
  /**
   * Config key path hint for humans.
   * (Keyed agent entries use `agents.entries.*.…` form.)
   */
  key: string;
};

export type SandboxToolPolicyResolved = SandboxToolPolicy & {
  allow: string[];
  deny: string[];
  sources: {
    allow: SandboxToolPolicySource;
    deny: SandboxToolPolicySource;
  };
};

export type SandboxWorkspaceAccess = NonNullable<AgentSandboxConfig["workspaceAccess"]>;

/** Prepared resource ownership; only proven profiles retain cross-session workspaces. */
export type SandboxIsolationSubject =
  | { kind: "profile"; profileId: string }
  | { kind: "session"; sessionKey: string };

type SandboxBrowserSettings = SchemaContract<NonNullable<AgentSandboxConfig["browser"]>>;
export type SandboxBrowserConfig = Required<
  Omit<SandboxBrowserSettings, "cdpSourceRange" | "binds">
> &
  Pick<SandboxBrowserSettings, "cdpSourceRange" | "binds">;

export type SandboxPruneConfig = Required<SchemaContract<NonNullable<AgentSandboxConfig["prune"]>>>;

export type SandboxSshConfig = {
  target?: string;
  command: string;
  workspaceRoot: string;
  strictHostKeyChecking: boolean;
  updateHostKeys: boolean;
  identityFile?: string;
  certificateFile?: string;
  knownHostsFile?: string;
  identityData?: string;
  certificateData?: string;
  knownHostsData?: string;
};

export type SandboxScope = NonNullable<AgentSandboxConfig["scope"]>;

export type SandboxConfig = {
  mode: "off" | "non-main" | "all";
  backend: SandboxBackendId;
  scope: SandboxScope;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceRoot: string;
  // Podman must omit only the inherited bare /run tmpfs default; explicit /run is rejected.
  dockerTmpfsSource: "default" | "configured";
  docker: SandboxDockerConfig;
  ssh: SandboxSshConfig;
  browser: SandboxBrowserConfig;
  tools: SandboxToolPolicy;
  prune: SandboxPruneConfig;
};

export type SandboxBrowserContext = {
  bridgeUrl: string;
  noVncUrl?: string;
  containerName: string;
};

export type SandboxContext = {
  enabled: boolean;
  /** Immutable creator policy: this session may never escape to a host execution target. */
  required?: true;
  /** Core-prepared execution projection; ordinary rw sandboxes retain the requested workspace. */
  workspaceSource?: "managed-worktree";
  /** Selected repository subdirectory within the full private projection. */
  workspaceCwd?: string;
  backendId: SandboxBackendId;
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  skillsEligibility?: SkillEligibilityContext;
  skillUsagePaths?: SkillUsagePath[];
  readOnlyResourceMounts?: Array<{ hostPath: string; containerPath: string }>;
  workspaceAccess: SandboxWorkspaceAccess;
  runtimeId: string;
  runtimeLabel: string;
  containerName: string;
  containerWorkdir: string;
  docker: SandboxDockerConfig;
  tools: SandboxToolPolicy;
  browserAllowHostControl: boolean;
  browser?: SandboxBrowserContext;
  fsBridge?: SandboxFsBridge;
  backend?: SandboxBackendHandle;
};

export type SandboxWorkspaceInfo = {
  workspaceDir: string;
  containerWorkdir?: string;
  skillsWorkspaceDir?: string;
  skillsEligibility?: SkillEligibilityContext;
  skillUsagePaths?: SkillUsagePath[];
  readOnlyResourceMounts?: Array<{ hostPath: string; containerPath: string }>;
  workspaceAccess?: SandboxWorkspaceAccess;
};
