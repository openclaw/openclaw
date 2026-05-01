export const CODEX_SDK_BACKEND_ID = "codex-sdk";
export const CODEX_SDK_PACKAGE_NAME = "@openai/codex-sdk";
export const CODEX_SDK_PINNED_VERSION = "0.128.0";
export const CODEX_SDK_INSTALL_COMMAND = `npm install ${CODEX_SDK_PACKAGE_NAME}@${CODEX_SDK_PINNED_VERSION}`;

export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export const CODEX_APPROVAL_POLICIES = ["never", "on-request", "on-failure", "untrusted"] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

export const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export const CODEX_WEB_SEARCH_MODES = ["disabled", "cached", "live"] as const;
export type CodexWebSearchMode = (typeof CODEX_WEB_SEARCH_MODES)[number];

export type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
export type CodexConfigObject = {
  [key: string]: CodexConfigValue;
};

export type CodexBackchannelConfig = {
  enabled?: boolean;
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  gatewayUrl?: string;
  allowedMethods?: string[];
  readMethods?: string[];
  safeWriteMethods?: string[];
  requireWriteToken?: boolean;
  writeTokenEnv?: string;
  requestTimeoutMs?: number;
  maxPayloadBytes?: number;
};

export type ResolvedCodexBackchannelConfig = Required<
  Pick<
    CodexBackchannelConfig,
    | "enabled"
    | "name"
    | "allowedMethods"
    | "readMethods"
    | "safeWriteMethods"
    | "requireWriteToken"
    | "writeTokenEnv"
    | "requestTimeoutMs"
    | "maxPayloadBytes"
  >
> &
  Omit<
    CodexBackchannelConfig,
    | "enabled"
    | "name"
    | "allowedMethods"
    | "readMethods"
    | "safeWriteMethods"
    | "requireWriteToken"
    | "writeTokenEnv"
    | "requestTimeoutMs"
    | "maxPayloadBytes"
  >;

export type CodexRouteConfig = {
  model?: string;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  modelReasoningEffort?: CodexReasoningEffort;
  skipGitRepoCheck?: boolean;
  networkAccessEnabled?: boolean;
  webSearchMode?: CodexWebSearchMode;
  additionalDirectories?: string[];
  instructions?: string;
  aliases?: string[];
};

export type ResolvedCodexRouteConfig = Required<Pick<CodexRouteConfig, "aliases">> &
  Omit<CodexRouteConfig, "aliases"> & {
    id: string;
    label: string;
  };

export type CodexSdkPluginConfig = {
  codexPath?: string;
  cwd?: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  modelReasoningEffort?: CodexReasoningEffort;
  skipGitRepoCheck?: boolean;
  networkAccessEnabled?: boolean;
  webSearchMode?: CodexWebSearchMode;
  baseUrl?: string;
  apiKeyEnv?: string;
  inheritEnv?: boolean;
  env?: Record<string, string>;
  additionalDirectories?: string[];
  allowedAgents?: string[];
  defaultRoute?: string;
  routes?: Record<string, CodexRouteConfig>;
  maxEventsPerSession?: number;
  proposalInboxLimit?: number;
  config?: CodexConfigObject;
  backchannel?: CodexBackchannelConfig;
};

export type ResolvedCodexSdkPluginConfig = Required<
  Pick<
    CodexSdkPluginConfig,
    | "inheritEnv"
    | "skipGitRepoCheck"
    | "sandboxMode"
    | "allowedAgents"
    | "maxEventsPerSession"
    | "proposalInboxLimit"
  >
> &
  Omit<
    CodexSdkPluginConfig,
    | "inheritEnv"
    | "skipGitRepoCheck"
    | "sandboxMode"
    | "allowedAgents"
    | "defaultRoute"
    | "routes"
    | "maxEventsPerSession"
    | "proposalInboxLimit"
    | "backchannel"
  > & {
    defaultRoute: string;
    routes: Record<string, ResolvedCodexRouteConfig>;
    backchannel: ResolvedCodexBackchannelConfig;
  };
