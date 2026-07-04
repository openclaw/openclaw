/**
 * Projects OpenClaw tool policy onto Claude CLI MCP permission requests.
 */
import crypto from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { TOOL_NAME_SEPARATOR } from "../agent-bundle-mcp-names.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { isToolAllowedByPolicyName } from "../tool-policy-match.js";
import { mergeAlsoAllowPolicy, type ToolPolicyLike } from "../tool-policy.js";
import type {
  ClaudeMcpServerToolPolicies,
  ClaudeMcpServerToolPolicy,
  PreparedCliRunContext,
} from "./types.js";

export type ClaudeLiveMcpToolDecision =
  | { matched: false }
  | { matched: true; allowed: true }
  | { matched: true; allowed: false; reason: string };

export type ClaudeLiveMcpToolPolicy = {
  hasExternalServers: boolean;
  hasComputerUseProxy: boolean;
  fingerprint: string;
  proxyServers: ClaudeMcpProxyServerPolicy[];
  decide(toolName: string): ClaudeLiveMcpToolDecision;
};

export type ClaudeMcpProxyServerPolicy = {
  runtimeName: string;
  configuredName: string;
  safeName: string;
  reservedToolNames: string[];
  toolFilter: ClaudeMcpServerToolPolicy;
  policies: Array<{ allow?: string[]; deny?: string[] }>;
};

type KnownMcpServer = {
  runtimeName: string;
  configuredName: string;
  safeName: string;
  toolFilter: ClaudeMcpServerToolPolicy;
};

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function globMatches(pattern: string, value: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return trimmed === value;
  }
  return new RegExp(`^${trimmed.split("*").map(escapeRegex).join(".*")}$`).test(value);
}

function toolFilterAllows(filter: ClaudeMcpServerToolPolicy, toolName: string): boolean {
  const include = filter.include ?? [];
  const exclude = filter.exclude ?? [];
  if (include.length > 0 && !include.some((pattern) => globMatches(pattern, toolName))) {
    return false;
  }
  return !exclude.some((pattern) => globMatches(pattern, toolName));
}

/** Return whether one raw MCP operation survives the configured server filter. */
export function isClaudeMcpProxyToolIncluded(
  policy: ClaudeMcpProxyServerPolicy,
  toolName: string,
): boolean {
  const normalizedToolName = toolName.trim();
  return normalizedToolName.length > 0 && toolFilterAllows(policy.toolFilter, normalizedToolName);
}

function policyAllowsAliases(
  policy: ToolPolicyLike | undefined,
  aliases: readonly string[],
): boolean {
  if (!policy) {
    return true;
  }
  const denied = aliases.some((alias) => !isToolAllowedByPolicyName(alias, { deny: policy.deny }));
  if (denied) {
    return false;
  }
  if (!policy.allow || policy.allow.length === 0) {
    return true;
  }
  return aliases.some((alias) => isToolAllowedByPolicyName(alias, { allow: policy.allow }));
}

function findMcpTool(
  toolName: string,
  servers: readonly KnownMcpServer[],
): { server: KnownMcpServer; toolName: string } | undefined {
  if (!toolName.startsWith("mcp__")) {
    return undefined;
  }
  for (const server of servers) {
    const prefix = `mcp__${server.runtimeName}__`;
    if (toolName.startsWith(prefix) && toolName.length > prefix.length) {
      return { server, toolName: toolName.slice(prefix.length) };
    }
  }
  return undefined;
}

function findNativeMcpServer(toolName: string, serverNames: readonly string[]): string | undefined {
  return serverNames.find((serverName) => {
    const prefix = `mcp__${serverName}__`;
    return toolName.startsWith(prefix) && toolName.length > prefix.length;
  });
}

function buildToolAliases(params: {
  claudeToolName: string;
  server: KnownMcpServer;
  toolName: string;
}): string[] {
  return [
    params.claudeToolName,
    `mcp__${params.server.configuredName}__${params.toolName}`,
    `${params.server.safeName}${TOOL_NAME_SEPARATOR}${params.toolName}`,
    "bundle-mcp",
    "group:plugins",
  ];
}

function buildKnownServers(policies: ClaudeMcpServerToolPolicies | undefined): KnownMcpServer[] {
  return Object.entries(policies ?? {})
    .map(([runtimeName, toolFilter]) => ({
      runtimeName,
      configuredName: toolFilter.configuredName,
      safeName: toolFilter.safeName,
      toolFilter,
    }))
    .toSorted((left, right) => right.runtimeName.length - left.runtimeName.length);
}

/** Apply the serialized OpenClaw policy attached to one Claude MCP proxy. */
export function isClaudeMcpProxyToolAllowed(
  policy: ClaudeMcpProxyServerPolicy,
  toolName: string,
  safeToolName = `${policy.safeName}${TOOL_NAME_SEPARATOR}${toolName}`,
): boolean {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName || !toolFilterAllows(policy.toolFilter, normalizedToolName)) {
    return false;
  }
  const aliases = buildToolAliases({
    claudeToolName: `mcp__${policy.runtimeName}__${normalizedToolName}`,
    server: policy,
    toolName: normalizedToolName,
  });
  aliases[2] = safeToolName;
  return policy.policies.every((entry) => policyAllowsAliases(entry, aliases));
}

/** Resolve the per-turn MCP permission policy used by Claude's live stdio runtime. */
export function resolveClaudeLiveMcpToolPolicy(
  context: PreparedCliRunContext,
): ClaudeLiveMcpToolPolicy {
  const managesMcpPolicy = context.preparedBackend.mcpServerToolPolicies !== undefined;
  const servers = buildKnownServers(context.preparedBackend.mcpServerToolPolicies);
  const nativeServerNames = [...(context.preparedBackend.mcpNativeServerNames ?? [])].toSorted(
    (left, right) => right.length - left.length,
  );
  const sandboxSessionKey = context.params.sandboxSessionKey ?? context.params.sessionKey;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: context.params.config,
    sessionKey: sandboxSessionKey,
  });
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: context.params.config,
    sessionKey: context.params.sessionKey,
    sandboxSessionKey,
    sessionId: context.params.sessionId,
    runId: context.params.runId,
    agentId: context.params.agentId,
    agentAccountId: context.params.agentAccountId,
    messageProvider: context.params.messageProvider,
    messageChannel: context.params.messageChannel,
    chatType: context.params.chatType,
    messageTo: context.params.messageTo ?? context.params.currentChannelId,
    messageThreadId: context.params.messageThreadId,
    currentChannelId: context.params.currentChannelId,
    currentThreadTs: context.params.currentThreadTs,
    currentMessageId: context.params.currentMessageId,
    groupId: context.params.groupId,
    groupChannel: context.params.groupChannel,
    groupSpace: context.params.groupSpace,
    spawnedBy: context.params.spawnedBy,
    senderId: context.params.senderId,
    senderName: context.params.senderName,
    senderUsername: context.params.senderUsername,
    senderE164: context.params.senderE164,
    senderIsOwner: context.params.senderIsOwner,
    modelProvider: context.backendResolved.modelProvider ?? "anthropic",
    modelId: context.modelId,
    workspaceDir: context.workspaceDir,
    cwd: context.cwd,
    skillsSnapshot: context.params.skillsSnapshot,
    sandboxToolPolicy: sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined,
  });
  const policy = capabilityProfile.policy;
  const policies = [
    mergeAlsoAllowPolicy(policy.profilePolicy, policy.profileAlsoAllow),
    mergeAlsoAllowPolicy(policy.providerProfilePolicy, policy.providerProfileAlsoAllow),
    policy.globalPolicy,
    policy.globalProviderPolicy,
    policy.agentPolicy,
    policy.agentProviderPolicy,
    policy.groupPolicy,
    policy.senderPolicy,
    policy.sandboxPolicy,
    policy.subagentPolicy,
    policy.inheritedToolPolicy,
  ];
  const serializablePolicies = policies
    .filter((entry): entry is ToolPolicyLike => Boolean(entry))
    .map((entry) => {
      const serialized: { allow?: string[]; deny?: string[] } = {};
      if (entry.allow) {
        serialized.allow = [...entry.allow];
      }
      if (entry.deny) {
        serialized.deny = [...entry.deny];
      }
      return serialized;
    });
  const proxyServers = servers
    .filter((server) => server.configuredName !== "openclaw")
    .map((server) => ({
      runtimeName: server.runtimeName,
      configuredName: server.configuredName,
      safeName: server.safeName,
      reservedToolNames: [...(context.mcpReservedToolNames ?? [])],
      toolFilter: server.toolFilter,
      policies: serializablePolicies,
    }));
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        proxyServers,
      }),
    )
    .digest("hex");

  return {
    hasExternalServers: servers.some((server) => server.configuredName !== "openclaw"),
    hasComputerUseProxy: proxyServers.some(
      (server) => normalizeLowercaseStringOrEmpty(server.configuredName) === "computer-use",
    ),
    fingerprint,
    proxyServers,
    decide(toolName) {
      if (!managesMcpPolicy) {
        // A custom Claude stdio runtime without generated MCP metadata owns its
        // native MCP surface. The normal Claude exec permission path still applies.
        return { matched: false };
      }
      const match = findMcpTool(toolName, servers);
      const nativeServerName = findNativeMcpServer(toolName, nativeServerNames);
      if (
        nativeServerName &&
        (!match || nativeServerName.length > match.server.runtimeName.length)
      ) {
        return { matched: false };
      }
      if (!match) {
        return toolName.startsWith("mcp__")
          ? {
              matched: true,
              allowed: false,
              reason: `OpenClaw denied unconfigured MCP tool ${toolName}.`,
            }
          : { matched: false };
      }
      if (match.server.configuredName === "openclaw") {
        // The loopback server materializes the effective OpenClaw tool surface itself.
        return { matched: true, allowed: true };
      }
      if (!toolFilterAllows(match.server.toolFilter, match.toolName)) {
        return {
          matched: true,
          allowed: false,
          reason: `OpenClaw MCP filter denied ${toolName}.`,
        };
      }
      // The proxy owns effective allow/deny enforcement because it has the full
      // upstream catalog needed to reproduce collision-safe OpenClaw tool ids.
      return { matched: true, allowed: true };
    },
  };
}
