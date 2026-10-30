import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAgentToolAssistantTurnId } from "../../packages/agent-core/src/tool-execution-context.js";
import { getRuntimeConfigSnapshot, selectLiveRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMessageActionTurnAuthorization,
  resolveMessageActionTurnCapability,
  selectMessageActionRequesterIdentity,
} from "../gateway/message-action-turn-capability.js";
import { listConnectedNodePluginTools } from "../gateway/node-plugin-tool-snapshot.js";
import {
  NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS,
  NODE_MCP_TOOL_CALL_TIMEOUT_MS,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_PLUGIN_TOOL_CALL_GATEWAY_TIMEOUT_MS,
  NODE_PLUGIN_TOOL_CALL_TIMEOUT_MS,
} from "../infra/node-commands.js";
import { resolveAgentScopedOutboundMediaAccess } from "../media/read-capability.js";
import { resolveProviderAuthScope } from "../plugins/provider-auth-scope.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginToolAllowlist } from "../plugins/tool-grant-allowlist.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { OpenClawPluginToolDelivery } from "../plugins/tool-types.js";
import { resolvePluginTools, resolvePluginToolsSteps } from "../plugins/tools.js";
import type { OpenClawPluginToolContext } from "../plugins/types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { sanitizeNodeIdFragment, sanitizeServerName } from "./agent-bundle-mcp-names.js";
import { resolveApiKeyForProfile, resolveAuthProfileOrder } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { bindRequesterOwnerIdentity } from "./cron-creator-authority-context.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import {
  projectMcpCallToolResult,
  setMcpCodeModeGuestResultFromAgentResult,
} from "./mcp-content.js";
import {
  createRuntimeProviderAuthLookup,
  hasRuntimeAvailableProviderAuth,
  resolveApiKeyForProviderCore as resolveProviderAuth,
} from "./model-auth.js";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";
import { preparePluginToolExecutionCapabilities } from "./plugin-tool-execution.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { captureGatewayToolCallerAssertion } from "./tools/gateway-caller-context.js";
import { callGatewayTool } from "./tools/gateway.js";
import { hasProviderAuthForTool } from "./tools/model-config.helpers.js";
import { captureAgentWorkspaceReadiness } from "./workspace-readiness.js";

const NODE_PLUGIN_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NODE_PLUGIN_TOOL_NAME_MAX_LENGTH = 64;
const NODE_MCP_PLUGIN_ID = "node-mcp";

type MaterializedNodeToolEntry = ReturnType<typeof listConnectedNodePluginTools>[number] & {
  command: string;
  normalizedName: string;
};

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return isRecord(value) && Array.isArray(value.content);
}

type ResolveOpenClawPluginToolsOptions = OpenClawPluginToolOptions & {
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  pluginToolAllowlist?: string[];
  pluginToolDenylist?: string[];
  clientCaps?: string[];
  authProfileStore?: AuthProfileStore;
};

const loadMessageActionRunner = createLazyRuntimeModule(
  () => import("../infra/outbound/message-action-runner.js"),
);

function createPluginToolDelivery(params: {
  options: ResolveOpenClawPluginToolsOptions | undefined;
  context: OpenClawPluginToolContext;
  bindingConfig: OpenClawConfig | undefined;
  resolveConfig: () => OpenClawConfig | undefined;
}): OpenClawPluginToolDelivery | undefined {
  const deliveryContext = params.context.deliveryContext;
  const agentId = params.context.agentId;
  const sessionKey = params.context.sessionKey;
  const sessionId = params.context.sessionId;
  const senderIsOwner = params.context.senderIsOwner;
  const conversationReadOrigin = params.context.conversationReadOrigin;
  const runId = params.options?.runId;
  const workspaceReadiness = captureAgentWorkspaceReadiness(
    params.options?.runSessionKey ?? params.options?.agentSessionKey,
  );
  const token = params.options?.messageActionTurnCapability;
  const activeRegistry = getActivePluginRegistry();
  const activeRegistryVersion = getActivePluginRegistryVersion();
  if (
    !deliveryContext?.channel ||
    !deliveryContext.to ||
    !agentId ||
    !sessionKey ||
    !runId ||
    !token ||
    !activeRegistry
  ) {
    return undefined;
  }
  // Capabilities bind the source policy session, even when plugins execute in
  // a shared or durable session. Keep validation separate from execution identity.
  const policySessionKey = params.options?.agentSessionKey ?? sessionKey;
  const turnIdentity = {
    token,
    agentId,
    runId,
    sessionKey: policySessionKey,
    sessionId,
  };
  const messageActionAuthorization = resolveMessageActionTurnAuthorization(turnIdentity);
  if (messageActionAuthorization?.scheduled || messageActionAuthorization?.deliveryAttempt) {
    // Cron capabilities are consumed by individual message actions. They do not
    // delegate the source conversation's plugin delivery capability.
    return undefined;
  }
  const channelPlugin = activeRegistry.channels.find(
    (entry) => entry.plugin.id === deliveryContext.channel,
  )?.plugin;
  // The turn capability and sender-scoped media reader are process-local.
  // Gateway-owned delivery needs a server-verifiable authority contract first.
  if (channelPlugin?.outbound?.deliveryMode === "gateway") {
    return undefined;
  }
  const route = {
    channel: deliveryContext.channel,
    to: deliveryContext.to,
    accountId: deliveryContext.accountId,
    threadId: deliveryContext.threadId,
  };

  const resolveAuthorization = () => {
    if (
      getActivePluginRegistry() !== activeRegistry ||
      getActivePluginRegistryVersion() !== activeRegistryVersion
    ) {
      throw new Error("plugin delivery capability is no longer active");
    }
    const authorization = resolveMessageActionTurnCapability(turnIdentity);
    if (!authorization) {
      throw new Error("plugin delivery capability is no longer active");
    }
    return authorization;
  };
  const bindingAuthorization = resolveAuthorization();
  const bindingConfig = params.bindingConfig;
  if (!bindingConfig) {
    return undefined;
  }
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: bindingConfig,
    agentId,
    workspaceDir: params.context.workspaceDir,
    sessionKey,
    accountId: bindingAuthorization.requesterAccountId ?? route.accountId,
    requesterSenderId: bindingAuthorization.requesterSenderId,
    requesterSenderName: bindingAuthorization.requesterSenderName,
    requesterSenderUsername: bindingAuthorization.requesterSenderUsername,
    requesterSenderE164: bindingAuthorization.requesterSenderE164,
  });

  return {
    send: async ({ text, mediaUrl }) => {
      resolveAuthorization();
      const { runMessageAction } = await loadMessageActionRunner();
      const authorization = resolveAuthorization();
      const cfg = params.resolveConfig();
      if (!cfg) {
        throw new Error("plugin delivery requires an active runtime config");
      }
      await withPluginRuntimeRegistryScope(activeRegistry, () =>
        runMessageAction({
          cfg,
          action: "send",
          params: {
            channel: route.channel,
            target: route.to,
            ...(route.accountId ? { accountId: route.accountId } : {}),
            ...(route.threadId != null ? { threadId: route.threadId } : {}),
            ...(text !== undefined ? { message: text } : {}),
            ...(mediaUrl !== undefined ? { mediaUrl } : {}),
          },
          defaultAccountId: route.accountId,
          ...selectMessageActionRequesterIdentity(authorization),
          messageActionAuthorization: {
            requesterAccountId: authorization.requesterAccountId,
            requesterSenderId: authorization.requesterSenderId,
            toolContext: authorization.toolContext,
          },
          senderIsOwner,
          conversationReadOrigin,
          toolContext: authorization.toolContext,
          sessionKey,
          sessionId,
          runId,
          agentId,
          mediaAccess,
          workspaceReadiness,
          onPlatformSendDispatch: async () => {
            resolveAuthorization();
          },
          forceCoreDelivery: true,
          skipQueue: true,
          dryRun: false,
        }),
      );
      resolveAuthorization();
    },
  };
}

type PluginToolOptions = {
  options?: ResolveOpenClawPluginToolsOptions;
  resolvedConfig?: OpenClawConfig;
  existingToolNames?: Set<string>;
};

export async function resolveOpenClawPluginToolsForOptionsAsync(
  params: PluginToolOptions,
): Promise<AnyAgentTool[]> {
  const steps = resolveOpenClawPluginToolSteps(params);
  let step = steps.next();
  while (!step.done) {
    await step.value;
    step = steps.next();
  }
  return step.value;
}

export function resolveOpenClawPluginToolsForOptions(params: PluginToolOptions): AnyAgentTool[] {
  const steps = resolveOpenClawPluginToolSteps(params);
  const step = steps.next();
  if (!step.done) {
    void step.value.catch(() => {});
    throw new Error("Workspace preparation is pending; use asynchronous tool construction.");
  }
  return step.value;
}

function* resolveOpenClawPluginToolSteps(
  params: PluginToolOptions,
): Generator<Promise<void>, AnyAgentTool[], void> {
  const inputConfig = params.resolvedConfig ?? params.options?.config;
  const availabilityConfig = selectLiveRuntimeConfig(inputConfig);
  // Bind ownership before reload replaces the source snapshot. Explicit run
  // overrides stay isolated; runtime-owned contexts follow later publications.
  const followsRuntimeConfig =
    inputConfig === undefined || availabilityConfig === getRuntimeConfigSnapshot();
  const resolveCurrentRuntimeConfig = () =>
    followsRuntimeConfig ? selectLiveRuntimeConfig() : availabilityConfig;
  const pluginToolInputs = resolveOpenClawPluginToolInputs({
    options: params.options,
    resolvedConfig: params.resolvedConfig,
    runtimeConfig: availabilityConfig,
    getRuntimeConfig: resolveCurrentRuntimeConfig,
  });
  const authProfileStore = params.options?.authProfileStore;
  const requesterOwner =
    pluginToolInputs.context.senderIsOwner === true
      ? undefined
      : bindRequesterOwnerIdentity({
          runId: params.options?.runId,
          sessionKey: pluginToolInputs.context.sessionKey,
          sessionId: pluginToolInputs.context.sessionId,
          agentId: pluginToolInputs.context.agentId,
        });
  const delivery = createPluginToolDelivery({
    options: params.options,
    context: pluginToolInputs.context,
    bindingConfig: availabilityConfig,
    resolveConfig: resolveCurrentRuntimeConfig,
  });
  const availabilityRuntimeLookup = authProfileStore
    ? createRuntimeProviderAuthLookup({
        cfg: availabilityConfig,
        workspaceDir: pluginToolInputs.context.workspaceDir,
        includePluginSyntheticAuth: false,
      })
    : undefined;
  const hasAuthForProvider = authProfileStore
    ? (providerId: string) =>
        hasProviderAuthForTool({
          provider: providerId,
          cfg: availabilityConfig,
          workspaceDir: pluginToolInputs.context.workspaceDir,
          agentDir: params.options?.agentDir,
          authStore: authProfileStore,
          runtimeLookup: availabilityRuntimeLookup,
        })
    : undefined;
  const resolveApiKeyForProvider = authProfileStore
    ? async (providerId: string): Promise<string | undefined> => {
        const cfg = resolveCurrentRuntimeConfig();
        const workspaceDir = pluginToolInputs.context.workspaceDir;
        // This preparation excludes plugin auth, including agent-profile substitutes.
        if (
          resolveProviderAuthScope({ provider: providerId, config: cfg, workspaceDir }) === "plugin"
        ) {
          return undefined;
        }
        for (const profileId of resolveAuthProfileOrder({
          cfg,
          store: authProfileStore,
          provider: providerId,
          includePendingOAuthRefresh: true,
        })) {
          const resolved = await resolveApiKeyForProfile({
            cfg,
            store: authProfileStore,
            profileId,
            agentDir: params.options?.agentDir,
          });
          if (resolved?.apiKey) {
            return resolved.apiKey;
          }
        }
        const runtimeLookup = createRuntimeProviderAuthLookup({
          cfg,
          workspaceDir,
          includePluginSyntheticAuth: false,
        });
        if (
          !hasRuntimeAvailableProviderAuth({
            provider: providerId,
            cfg,
            workspaceDir,
            allowPluginSyntheticAuth: false,
            runtimeLookup,
          })
        ) {
          return undefined;
        }
        try {
          const resolved = await resolveProviderAuth({
            provider: providerId,
            cfg,
            store: authProfileStore,
            agentDir: params.options?.agentDir,
            workspaceDir,
            credentialPrecedence: "env-first",
            allowAuthProfileFallback: false,
          });
          return resolved.apiKey;
        } catch {
          return undefined;
        }
      }
    : undefined;
  const existingToolNames = new Set(params.existingToolNames ?? []);
  const preparedModelRuntime = params.options?.preparedModelRuntime;
  const requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const runtimeRegistry = requestRegistry ?? getActivePluginRegistry() ?? undefined;
  // A scoped registry can own prepared plugin facts without a model runtime (headless cron).
  // Never borrow process-global load facts for an unrelated direct caller.
  const preparedRegistry = preparedModelRuntime
    ? preparedModelRuntime.pluginRegistry
    : requestRegistry;
  const loadContext = getPluginRuntimeLoadContext(preparedRegistry);
  const metadataSnapshot = preparedModelRuntime?.metadataSnapshot ?? loadContext?.metadataSnapshot;
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const assertRequestCurrent = params.options?.assertInvocationCurrent;
  const resolution = {
    ...pluginToolInputs,
    bindExecutionCapabilities: preparePluginToolExecutionCapabilities({
      sandbox: params.options?.sandbox?.enabled ? params.options.sandbox : undefined,
      skillsSnapshot: params.options?.pluginExecutionSkillsSnapshot,
      signal: params.options?.abortSignal,
      authority: params.options?.pluginExecutionAuthority,
      modelContextWindowTokens: params.options?.modelContextWindowTokens,
      preparedModelRuntime,
      config: availabilityConfig,
      agentId: pluginToolInputs.context.agentId,
      sessionKey: pluginToolInputs.context.sessionKey,
      sessionId: pluginToolInputs.context.sessionId,
    }),
    context: {
      ...pluginToolInputs.context,
      ...(delivery ? { delivery } : {}),
      ...(hasAuthForProvider ? { hasAuthForProvider } : {}),
      ...(resolveApiKeyForProvider ? { resolveApiKeyForProvider } : {}),
    },
    existingToolNames,
    assertInvocationCurrent: assertRequestCurrent
      ? () => {
          assertCallerCurrent?.();
          assertRequestCurrent();
        }
      : assertCallerCurrent,
    ownerContinuation: requesterOwner,
    clientCaps: params.options?.clientCaps,
    toolAllowlist: params.options?.pluginToolAllowlist,
    toolDenylist: params.options?.pluginToolDenylist,
    allowGatewaySubagentBinding: params.options?.allowGatewaySubagentBinding,
    ...(hasAuthForProvider ? { hasAuthForProvider } : {}),
    ...(runtimeRegistry ? { runtimeRegistry } : {}),
    ...(metadataSnapshot
      ? {
          preparedRuntime: {
            loadContext,
            metadataSnapshot,
            registry: preparedRegistry,
          },
        }
      : {}),
  };
  const pluginTools = captureAgentWorkspaceReadiness(pluginToolInputs.context.sessionKey)
    ? yield* resolvePluginToolsSteps(resolution)
    : resolvePluginTools(resolution);
  for (const tool of pluginTools) {
    existingToolNames.add(tool.name);
  }
  const nodeAgentSessionKey = pluginToolInputs.context.sessionKey;
  const existingNormalized = new Set([...existingToolNames].map(normalizeToolPolicyName));
  const allowlist = createPluginToolAllowlist(params.options?.pluginToolAllowlist);
  const denylist = compileGlobPatterns({
    raw: params.options?.pluginToolDenylist,
    normalize: normalizeToolPolicyName,
  });
  const entries: MaterializedNodeToolEntry[] = [];
  const nameCounts = new Map<string, number>();
  for (const entry of listConnectedNodePluginTools()) {
    const descriptor = entry.descriptor;
    const command = descriptor.command?.trim();
    const normalizedName = normalizeToolPolicyName(descriptor.name);
    if (!command || !normalizedName) {
      continue;
    }
    entries.push({ ...entry, command, normalizedName });
    nameCounts.set(normalizedName, (nameCounts.get(normalizedName) ?? 0) + 1);
  }

  for (const entry of entries) {
    const descriptor = entry.descriptor;
    let toolName: string | undefined = descriptor.name;
    if (
      (nameCounts.get(entry.normalizedName) ?? 1) !== 1 ||
      existingNormalized.has(entry.normalizedName)
    ) {
      toolName = undefined;
      const prefix = `${sanitizeNodeIdFragment(entry.nodeId)}_`;
      for (let index = 0; index < 100; index += 1) {
        const suffix = index === 0 ? "" : `_${index + 1}`;
        const maxBaseLength = Math.max(
          1,
          NODE_PLUGIN_TOOL_NAME_MAX_LENGTH - prefix.length - suffix.length,
        );
        const candidate = `${prefix}${descriptor.name.slice(0, maxBaseLength)}${suffix}`;
        const normalized = normalizeToolPolicyName(candidate);
        if (
          NODE_PLUGIN_TOOL_NAME_RE.test(candidate) &&
          normalized &&
          !existingNormalized.has(normalized)
        ) {
          toolName = candidate;
          break;
        }
      }
    }
    if (!toolName) {
      continue;
    }
    const pluginId = normalizeToolPolicyName(descriptor.pluginId);
    const exposedToolName = normalizeToolPolicyName(toolName);
    if (
      matchesAnyGlobPattern(pluginId, denylist) ||
      matchesAnyGlobPattern(entry.normalizedName, denylist) ||
      matchesAnyGlobPattern(exposedToolName, denylist) ||
      matchesAnyGlobPattern("group:plugins", denylist)
    ) {
      continue;
    }
    // Unregistered nodes cannot grant themselves plugin-scoped access by
    // claiming another plugin's ID. Only the reserved node-mcp ID is trusted.
    const pluginIdTrusted = entry.registered || pluginId === NODE_MCP_PLUGIN_ID;
    if (
      !allowlist.includesDefaults &&
      !(
        (pluginIdTrusted && allowlist.allowsPlugin(pluginId)) ||
        allowlist.allowsToolName(entry.normalizedName) ||
        allowlist.allowsToolName(exposedToolName)
      )
    ) {
      continue;
    }
    existingNormalized.add(exposedToolName);
    const mcpTool = descriptor.command === NODE_MCP_TOOLS_CALL_COMMAND ? descriptor.mcp : undefined;
    const tool: AnyAgentTool = {
      name: toolName,
      label: toolName,
      description: `${descriptor.description} (node: ${entry.displayName?.trim() || entry.nodeId})`,
      // SAFETY: normalized paired-node JSON schemas need no TypeBox-only metadata when forwarded.
      parameters: descriptor.parameters as never,
      ...(mcpTool
        ? { executionMode: "sequential" as const, resultContentSource: "network" as const }
        : {}),
      execute: async (toolCallId, toolParams, signal) => {
        const assistantTurnId = getAgentToolAssistantTurnId();
        const raw = await callGatewayTool(
          "node.invoke",
          {
            timeoutMs: mcpTool
              ? NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS
              : NODE_PLUGIN_TOOL_CALL_GATEWAY_TIMEOUT_MS,
          },
          {
            nodeId: entry.nodeId,
            command: entry.command,
            params: mcpTool
              ? {
                  server: mcpTool.server,
                  tool: mcpTool.tool,
                  arguments: toolParams,
                }
              : toolParams,
            timeoutMs: mcpTool ? NODE_MCP_TOOL_CALL_TIMEOUT_MS : NODE_PLUGIN_TOOL_CALL_TIMEOUT_MS,
            idempotencyKey: assistantTurnId ? `${assistantTurnId}:${toolCallId}` : toolCallId,
            ...(nodeAgentSessionKey ? { sessionKey: nodeAgentSessionKey } : {}),
          },
          { scopes: ["operator.write"], ...(signal ? { signal } : {}) },
        );
        const payload = isRecord(raw) && "payload" in raw ? raw.payload : raw;
        if (mcpTool) {
          return isRecord(payload)
            ? projectMcpCallToolResult(payload, {
                mcpServer: mcpTool.server,
                mcpTool: mcpTool.tool,
              })
            : jsonResult(payload);
        }
        const result = isAgentToolResult(payload) ? payload : jsonResult(payload);
        return descriptor.mcp ? setMcpCodeModeGuestResultFromAgentResult(result) : result;
      },
    };
    setPluginToolMeta(tool, {
      pluginId: descriptor.pluginId,
      optional: false,
      ...(descriptor.mcp
        ? {
            mcp: {
              serverName: descriptor.mcp.server,
              safeServerName: sanitizeServerName(descriptor.mcp.server, new Set<string>()),
              toolName: descriptor.mcp.tool,
              operation: "tool",
              ...(descriptor.pluginId === NODE_MCP_PLUGIN_ID && mcpTool
                ? {
                    node: {
                      id: entry.nodeId,
                      ...(entry.displayName?.trim()
                        ? { displayName: entry.displayName.trim() }
                        : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
    });
    pluginTools.push(tool);
  }

  return pluginTools;
}
