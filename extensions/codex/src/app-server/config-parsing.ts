import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { detectWindowsSpawnCommandInlineArgs } from "openclaw/plugin-sdk/windows-spawn";
import { z } from "zod";
import {
  CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN,
  type CodexAppServerCommandSource,
  type CodexPluginDestructiveApprovalMode,
  type CodexPluginDestructivePolicy,
  type ResolvedCodexPluginPolicy,
  type ResolvedCodexPluginsPolicy,
} from "./config-contracts.shared.js";
import { normalizeCodexServiceTier } from "./config-utils.js";
import {
  codexDiscoveryConfigSchema,
  codexSessionCatalogConfigSchema,
} from "./session-discovery-config.js";

export const DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME = "computer-use";
export const DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME = "computer-use";
export const DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS = 60_000;
export const DEFAULT_CODEX_COMPUTER_USE_LIVE_TEST_TIMEOUT_MS = 60_000;
export const DEFAULT_CODEX_COMPUTER_USE_TOOL_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_CODEX_COMPUTER_USE_HEALTH_CHECK_INTERVAL_MINUTES = 60;
export const DEFAULT_CODEX_APP_SERVER_NETWORK_PROXY_PROFILE_PREFIX = "openclaw-network";

const SecretInputSchema = buildSecretInputSchema();
const codexAppServerApprovalPolicySchema = z.preprocess(
  (value) => (value === "on-failure" ? "on-request" : value),
  z.enum(["never", "on-request"]),
);
const codexComputerUseHealthIntervalSchema = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal(240),
]);
const codexPluginDestructivePolicySchema = z.union([
  z.boolean(),
  z.literal("auto"),
  z.literal("ask"),
]);
const codexAppServerServiceTierSchema = z
  .preprocess(
    (value) => (value === null ? null : normalizeCodexServiceTier(value)),
    z.string().trim().min(1).nullable().optional(),
  )
  .optional();
const codexAppServerCyberFailoverSchema = z.strictObject({
  mode: z.enum(["auto", "off"]).optional(),
  model: z.string().trim().min(1).optional(),
  cooloffMs: z.number().positive().optional(),
});
const codexAppServerExperimentalSchema = z.strictObject({
  sandboxExecServer: z.boolean().optional(),
});
const codexAppServerNetworkProxySchema = z.strictObject({
  enabled: z.boolean().optional(),
  profileName: z.string().trim().min(1).optional(),
  baseProfile: z.enum(["read-only", "workspace"]).optional(),
  mode: z.enum(["limited", "full"]).optional(),
  domains: z.record(z.string(), z.enum(["allow", "deny"])).optional(),
  unixSockets: z.record(z.string(), z.enum(["allow", "none"])).optional(),
  proxyUrl: z.string().trim().min(1).optional(),
  socksUrl: z.string().trim().min(1).optional(),
  enableSocks5: z.boolean().optional(),
  enableSocks5Udp: z.boolean().optional(),
  allowUpstreamProxy: z.boolean().optional(),
  allowLocalBinding: z.boolean().optional(),
  dangerouslyAllowNonLoopbackProxy: z.boolean().optional(),
  dangerouslyAllowAllUnixSockets: z.boolean().optional(),
});

const codexPluginEntryConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  marketplaceName: z.string().regex(CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN).optional(),
  pluginName: z.string().trim().min(1).optional(),
  allow_destructive_actions: codexPluginDestructivePolicySchema.optional(),
});

const codexPluginsConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  allow_all_plugins: z.boolean().optional(),
  allow_destructive_actions: codexPluginDestructivePolicySchema.optional(),
  plugins: z.record(z.string(), codexPluginEntryConfigSchema).optional(),
});

const codexSupervisionEndpointSchema = z.union([
  z.strictObject({
    id: z.string().optional(),
    label: z.string().optional(),
    transport: z.literal("stdio-proxy").optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.strictObject({
    id: z.string().optional(),
    label: z.string().optional(),
    transport: z.literal("websocket"),
    url: z.string(),
    authTokenEnv: z.string().optional(),
  }),
]);

const codexSupervisionConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  endpoints: z.array(codexSupervisionEndpointSchema).optional(),
  allowRawTranscripts: z.boolean().optional(),
  allowWriteControls: z.boolean().optional(),
});

const codexPluginConfigSchema = z.strictObject({
  codexDynamicToolsLoading: z.enum(["searchable", "direct"]).optional(),
  codexDynamicToolsExclude: z.array(z.string()).optional(),
  sessionCatalog: codexSessionCatalogConfigSchema.optional(),
  discovery: codexDiscoveryConfigSchema.optional(),
  computerUse: z
    .strictObject({
      enabled: z.boolean().optional(),
      autoInstall: z.boolean().optional(),
      marketplaceDiscoveryTimeoutMs: z.number().positive().optional(),
      liveTestTimeoutMs: z.number().positive().optional(),
      toolCallTimeoutMs: z.number().positive().optional(),
      healthCheckEnabled: z.boolean().optional(),
      healthCheckIntervalMinutes: codexComputerUseHealthIntervalSchema.optional(),
      pluginCacheMode: z.enum(["shared", "independent"]).optional(),
      strictReadiness: z.boolean().optional(),
      autoRepair: z.boolean().optional(),
      marketplaceSource: z.string().optional(),
      marketplacePath: z.string().optional(),
      marketplaceName: z.string().optional(),
      pluginName: z.string().optional(),
      mcpServerName: z.string().optional(),
    })
    .optional(),
  codexPlugins: z.unknown().optional(),
  supervision: codexSupervisionConfigSchema.optional(),
  appServer: z
    .strictObject({
      mode: z.enum(["yolo", "guardian"]).optional(),
      transport: z.enum(["stdio", "websocket", "unix"]).optional(),
      homeScope: z.enum(["agent", "user"]).optional(),
      command: z.string().optional(),
      args: z.union([z.array(z.string()), z.string()]).optional(),
      url: z.string().optional(),
      authToken: SecretInputSchema.optional(),
      headers: z.record(z.string(), SecretInputSchema).optional(),
      clearEnv: z.array(z.string()).optional(),
      remoteWorkspaceRoot: z.string().trim().min(1).optional(),
      codeModeOnly: z.boolean().optional(),
      loopDetectionPreToolUseRelay: z.boolean().optional(),
      requestTimeoutMs: z.number().positive().optional(),
      approvalPolicy: codexAppServerApprovalPolicySchema.optional(),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
      approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]).optional(),
      serviceTier: codexAppServerServiceTierSchema,
      cyberFailover: codexAppServerCyberFailoverSchema.optional(),
      networkProxy: codexAppServerNetworkProxySchema.optional(),
      defaultWorkspaceDir: z.string().optional(),
      experimental: codexAppServerExperimentalSchema.optional(),
    })
    .optional(),
});

export type ParsedCodexSupervisionEndpoint = z.infer<typeof codexSupervisionEndpointSchema>;
export type ParsedCodexPluginConfig = Omit<
  z.infer<typeof codexPluginConfigSchema>,
  "codexPlugins"
> & {
  codexPlugins?: z.infer<typeof codexPluginsConfigSchema>;
};

export function readCodexPluginConfig(value: unknown): ParsedCodexPluginConfig {
  const appServer = asNullableRecord(asNullableRecord(value)?.appServer);
  if (appServer?.approvalPolicy === "untrusted") {
    throw new Error(
      'plugins.entries.codex.config.appServer.approvalPolicy="untrusted" is retired; run "openclaw doctor --fix" to migrate it to "on-request".',
    );
  }
  const parsed = codexPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    if (asNullableRecord(appServer?.networkProxy)?.enabled === true) {
      const issuePath = parsed.error.issues[0]?.path ?? [];
      // Record keys (domains, headers, etc.) are values, not safe diagnostic field names.
      const fieldDepth = issuePath[0] === "appServer" && issuePath[1] === "networkProxy" ? 3 : 2;
      const fieldPath = ["plugins.entries.codex.config", ...issuePath.slice(0, fieldDepth)].join(
        ".",
      );
      throw new Error(
        `Invalid ${fieldPath}; fix this field before starting Codex with network restrictions. Run "openclaw doctor --fix" for supported repairs.`,
      );
    }
    return {};
  }
  const { codexPlugins: rawCodexPlugins, ...config } = parsed.data;
  const plugins = codexPluginsConfigSchema.safeParse(rawCodexPlugins);
  if (!plugins.success) {
    return config;
  }
  return { ...config, codexPlugins: plugins.data };
}

export function isCodexSandboxExecServerEnabled(
  pluginConfig?: unknown,
  sandbox?: unknown,
): boolean {
  return (
    isCodexRemoteExecPlacementSandbox(sandbox) ||
    readCodexPluginConfig(pluginConfig).appServer?.experimental?.sandboxExecServer === true
  );
}

export function isCodexRemoteExecPlacementSandbox(sandbox: unknown): boolean {
  return (
    typeof sandbox === "object" &&
    sandbox !== null &&
    "placementExecutionMode" in sandbox &&
    sandbox.placementExecutionMode === "remote-exec"
  );
}

export function isCodexPairedNodeRemoteExecPlacementSandbox(sandbox: unknown): boolean {
  return (
    isCodexRemoteExecPlacementSandbox(sandbox) &&
    typeof sandbox === "object" &&
    sandbox !== null &&
    "placementNodeId" in sandbox &&
    typeof sandbox.placementNodeId === "string" &&
    sandbox.placementNodeId.length > 0
  );
}

export function assertCodexAppServerCommandHasNoInlineArgs(params: {
  command: string;
  source: CodexAppServerCommandSource;
}): void {
  const inlineArgs = detectWindowsSpawnCommandInlineArgs(params.command);
  if (!inlineArgs) {
    return;
  }
  const sourceLabel =
    params.source === "env"
      ? "OPENCLAW_CODEX_APP_SERVER_BIN"
      : "plugins.entries.codex.config.appServer.command";
  const argsLabel =
    params.source === "env"
      ? "OPENCLAW_CODEX_APP_SERVER_ARGS"
      : "plugins.entries.codex.config.appServer.args";
  throw new Error(
    `${sourceLabel} must be only the Codex app-server executable path; "${inlineArgs.executable}" was configured with inline arguments "${inlineArgs.arguments}". Move those arguments to ${argsLabel}, or remove the override to use the managed Codex startup path.`,
  );
}

export function resolveCodexPluginsPolicy(pluginConfig?: unknown): ResolvedCodexPluginsPolicy {
  const config = readCodexPluginConfig(pluginConfig).codexPlugins;
  const configured = config !== undefined;
  const enabled = config?.enabled === true;
  const destructivePolicy = resolveCodexPluginDestructivePolicy(
    config?.allow_destructive_actions ?? true,
  );
  const pluginPolicies = Object.entries(config?.plugins ?? {})
    .flatMap(([configKey, entry]): ResolvedCodexPluginPolicy[] => {
      if (!entry.marketplaceName || !entry.pluginName) {
        return [];
      }
      const entryDestructivePolicy = resolveCodexPluginDestructivePolicy(
        entry.allow_destructive_actions ?? config?.allow_destructive_actions ?? true,
      );
      return [
        {
          configKey,
          marketplaceName: entry.marketplaceName,
          pluginName: entry.pluginName,
          enabled: enabled && entry.enabled !== false,
          allowDestructiveActions: entryDestructivePolicy.allowDestructiveActions,
          destructiveApprovalMode: entryDestructivePolicy.destructiveApprovalMode,
        },
      ];
    })
    .toSorted((left, right) => left.configKey.localeCompare(right.configKey));
  return {
    configured,
    enabled,
    allowAllPlugins: enabled && config?.allow_all_plugins === true,
    allowDestructiveActions: destructivePolicy.allowDestructiveActions,
    destructiveApprovalMode: destructivePolicy.destructiveApprovalMode,
    pluginPolicies,
  };
}

function resolveCodexPluginDestructivePolicy(policy: CodexPluginDestructivePolicy): {
  allowDestructiveActions: boolean;
  destructiveApprovalMode: CodexPluginDestructiveApprovalMode;
} {
  if (policy === "auto" || policy === "ask") {
    return { allowDestructiveActions: true, destructiveApprovalMode: policy };
  }
  return {
    allowDestructiveActions: policy,
    destructiveApprovalMode: policy ? "allow" : "deny",
  };
}
