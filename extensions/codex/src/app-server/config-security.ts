import { hostname as readHostName } from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isLoopbackHost } from "openclaw/plugin-sdk/request-url";
import type {
  CodexAppServerConnectionClass,
  CodexAppServerDefaultPolicy,
  CodexAppServerEffectiveApprovalPolicy,
  CodexAppServerNetworkProxyConfig,
  CodexAppServerPolicyMode,
  CodexAppServerRuntimeOptions,
  CodexAppServerTransportMode,
  OpenClawExecMode,
  ResolvedCodexAppServerNetworkProxyConfig,
} from "./config-contracts.js";
import { selectGuardianSandbox } from "./config-exec-policy.js";
import { DEFAULT_CODEX_APP_SERVER_NETWORK_PROXY_PROFILE_PREFIX } from "./config-parsing.js";
import { fingerprintCodexPolicy } from "./config-policy-json.js";
import {
  parseCodexRequirementsPolicy,
  readCodexRequirementsToml,
  selectGuardianApprovalPolicy,
  selectGuardianApprovalsReviewer,
  selectUserApprovalsReviewer,
} from "./config-requirements.js";
import { readNonEmptyString } from "./config-utils.js";
import type { CodexSandboxMode, JsonObject, JsonValue } from "./protocol.js";

export function shouldAutoApproveCodexAppServerApprovals(
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy" | "networkProxy" | "sandbox">,
): boolean {
  return (
    appServer.networkProxy === undefined &&
    appServer.approvalPolicy === "never" &&
    appServer.sandbox === "danger-full-access"
  );
}

export function resolveCodexAppServerNetworkProxy(
  config: CodexAppServerNetworkProxyConfig | undefined,
  sandbox: CodexSandboxMode,
): { networkProxy?: ResolvedCodexAppServerNetworkProxyConfig } {
  if (config?.enabled !== true) {
    return {};
  }
  const fileSystemMode =
    config.baseProfile === "read-only" || (!config.baseProfile && sandbox === "read-only")
      ? "read"
      : "write";
  const networkConfig = removeUndefinedJsonFields({
    enabled: true,
    mode: config.mode,
    domains: normalizeNetworkProxyPermissionMap(config.domains),
    unix_sockets: normalizeNetworkProxyPermissionMap(config.unixSockets),
    proxy_url: readNonEmptyString(config.proxyUrl),
    socks_url: readNonEmptyString(config.socksUrl),
    enable_socks5: config.enableSocks5,
    enable_socks5_udp: config.enableSocks5Udp,
    allow_upstream_proxy: config.allowUpstreamProxy,
    allow_local_binding: config.allowLocalBinding,
    dangerously_allow_non_loopback_proxy: config.dangerouslyAllowNonLoopbackProxy,
    dangerously_allow_all_unix_sockets: config.dangerouslyAllowAllUnixSockets,
  });
  const profile = {
    filesystem: {
      ":minimal": "read",
      ":project_roots": {
        ".": fileSystemMode,
      },
    },
    network: networkConfig,
  };
  const profileName =
    readNonEmptyString(config.profileName) ??
    `${DEFAULT_CODEX_APP_SERVER_NETWORK_PROXY_PROFILE_PREFIX}-${fingerprintCodexPolicy({ version: 1, profile }).slice(0, 16)}`;
  const configPatch: JsonObject = {
    "features.network_proxy.enabled": true,
    default_permissions: profileName,
    permissions: {
      [profileName]: profile,
    },
  };
  return {
    networkProxy: {
      profileName,
      configFingerprint: fingerprintCodexPolicy(configPatch),
      configPatch,
    },
  };
}

function normalizeNetworkProxyPermissionMap(
  value: Record<string, "allow" | "deny" | "none"> | undefined,
): Record<string, "allow" | "deny"> | undefined {
  const entries = Object.entries(value ?? {})
    .map(([key, permission]) => [key.trim(), permission === "none" ? "deny" : permission] as const)
    .filter(([key]) => key.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function removeUndefinedJsonFields(value: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  );
}

/** Explicit MCP prompting must bypass Codex's unconditional Never-policy approval. */
export function hasCodexMcpToolApprovalOverrides(
  servers: NonNullable<OpenClawConfig["mcp"]>["servers"],
  serverNames?: readonly string[],
  projectedMcpServers?: Record<string, Record<string, unknown>>,
): boolean {
  const modes = new Map(
    Object.entries(projectedMcpServers ?? {}).map(([name, server]) => [
      name,
      server.default_tools_approval_mode,
    ]),
  );
  for (const name of serverNames ?? Object.keys(servers ?? {})) {
    const server = servers?.[name];
    const mode = server?.codex?.defaultToolsApprovalMode;
    // Prepared names already include session overrides that can re-enable a saved disabled server.
    if (mode !== undefined && (serverNames !== undefined || server?.enabled !== false)) {
      modes.set(name, mode);
    }
  }
  return [...modes.values()].some((mode) => mode === "auto" || mode === "prompt");
}

export function withMcpElicitationsApprovalPolicy(
  policy: CodexAppServerEffectiveApprovalPolicy,
): CodexAppServerEffectiveApprovalPolicy {
  // UnlessTrusted already allows MCP elicitation; granular would erase per-command approvals.
  if (policy === "untrusted") {
    return policy;
  }
  if (typeof policy !== "string") {
    return {
      granular: {
        ...policy.granular,
        mcp_elicitations: true,
      },
    };
  }
  const prompting = policy !== "never";
  return {
    granular: {
      mcp_elicitations: true,
      rules: prompting,
      sandbox_approval: prompting,
      request_permissions: prompting,
      skill_approval: prompting,
    },
  };
}

export function resolveTransport(value: unknown): CodexAppServerTransportMode {
  return value === "websocket" || value === "unix" ? value : "stdio";
}

export function inferCodexAppServerConnectionClass(params: {
  transport: CodexAppServerTransportMode;
  url?: string;
}): CodexAppServerConnectionClass {
  if (params.transport !== "websocket") {
    return "local-loopback";
  }
  return params.url && isLoopbackWebSocketUrl(params.url) ? "local-loopback" : "remote";
}

/** Applies the canonical remote-auth boundary to any Codex AppServer transport. */
export function assertCodexAppServerConnectionSecurity(params: {
  transport: CodexAppServerTransportMode;
  url?: string;
  authToken?: string;
  headers: Record<string, string>;
}): void {
  if (
    inferCodexAppServerConnectionClass(params) === "remote" &&
    !hasIdentityBearingWebSocketAuth(params)
  ) {
    throw new Error(
      "remote Codex app-server WebSocket URLs require appServer.authToken or an Authorization header",
    );
  }
}

function isLoopbackWebSocketUrl(value: string): boolean {
  const parsed = URL.parse(value);
  if (parsed?.protocol !== "ws:" && parsed?.protocol !== "wss:") {
    return false;
  }
  return isLoopbackHost(parsed.hostname);
}

function hasIdentityBearingWebSocketAuth(params: {
  authToken?: string;
  headers: Record<string, string>;
}): boolean {
  if (readNonEmptyString(params.authToken)) {
    return true;
  }
  return Object.entries(params.headers).some(
    ([key, value]) =>
      key.trim().toLowerCase() === "authorization" && Boolean(readNonEmptyString(value)),
  );
}

export function resolvePolicyMode(value: unknown): CodexAppServerPolicyMode | undefined {
  return value === "guardian" || value === "yolo" ? value : undefined;
}

export function resolveDefaultCodexAppServerPolicy(params: {
  transport: CodexAppServerTransportMode;
  forceGuardian?: boolean;
  forceUserReviewer?: boolean;
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">;
  execModeRequiringUserReviewer?: OpenClawExecMode;
  env?: NodeJS.ProcessEnv;
  requirementsToml?: string | null;
  requirementsPath?: string;
  readRequirementsFile?: (path: string) => string | undefined;
  platform?: NodeJS.Platform;
  hostName?: string;
}): CodexAppServerDefaultPolicy {
  if (params.transport !== "stdio") {
    return { mode: "yolo", dangerFullAccessAllowed: true };
  }
  const content = readCodexRequirementsToml(params);
  if (content === undefined && !params.forceGuardian) {
    return { mode: "yolo", dangerFullAccessAllowed: true };
  }
  const { allowedSandboxModes, allowedApprovalPolicies, allowedApprovalsReviewers } =
    parseCodexRequirementsPolicy(
      content,
      content === undefined ? undefined : (readNonEmptyString(params.hostName) ?? readHostName()),
    );
  const yoloSandboxAllowed =
    allowedSandboxModes === undefined || allowedSandboxModes.has("danger-full-access");
  const yoloApprovalAllowed =
    allowedApprovalPolicies === undefined ||
    (allowedApprovalPolicies.has("never") && !allowedApprovalPolicies.has("untrusted"));
  const yoloReviewerAllowed =
    allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("user");
  if (!params.forceGuardian && yoloSandboxAllowed && yoloApprovalAllowed && yoloReviewerAllowed) {
    return { mode: "yolo", dangerFullAccessAllowed: true };
  }
  return {
    mode: "guardian",
    dangerFullAccessAllowed: yoloSandboxAllowed,
    approvalPolicy: selectGuardianApprovalPolicy(
      allowedApprovalPolicies,
      params.execModeRequiringPromptingApprovals,
    ),
    approvalsReviewer: params.forceUserReviewer
      ? selectUserApprovalsReviewer(allowedApprovalsReviewers, params.execModeRequiringUserReviewer)
      : selectGuardianApprovalsReviewer(
          allowedApprovalsReviewers,
          params.execModeRequiringPromptingApprovals === "auto" ? "auto" : undefined,
        ),
    sandbox: selectGuardianSandbox(allowedSandboxModes),
  };
}
