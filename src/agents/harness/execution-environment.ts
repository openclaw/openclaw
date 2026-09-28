import type { AgentRuntimeRestrictionErrorDetails } from "../../../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSessionEntry } from "../../config/sessions/session-accessor.sqlite-exact-read.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveGroupToolPolicy } from "../agent-tools.policy.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { resolveExecConfigState } from "../exec-defaults.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { resolveScheduledToolCallerContext } from "../scheduled-tool-policy.js";
import { isKnownCoreToolId } from "../tool-catalog.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import { isToolAllowedByPolicies } from "../tool-policy-match.js";
import {
  expandToolGroups,
  mergeAlsoAllowPolicy,
  normalizeToolPolicyName,
  readToolAllowlistIntersection,
  toolPolicyRestrictsTools,
} from "../tool-policy.js";
import { AgentHarnessPreflightError } from "./errors.js";
import type { AgentHarness } from "./types.js";

type ExecutionEnvironmentFacts = {
  sandboxed: boolean;
  sandboxRequired: boolean;
  workspaceOnly: boolean;
  permissionMode?: EmbeddedRunAttemptParams["permissionMode"];
  remoteExecution?: boolean;
  nativeRuntimeConsent?: string;
  toolPolicyRestricted?: boolean;
  workspaceRequired?: boolean;
};

type ExecutionRestriction = {
  reason: AgentRuntimeRestrictionErrorDetails["reason"];
  message: string;
};

/** Selection and invocation share this decision; a native working directory is not containment. */
function resolveAgentHarnessExecutionRestriction(
  harness: Pick<AgentHarness, "id" | "label" | "executionEnvironment">,
  facts: ExecutionEnvironmentFacts,
): ExecutionRestriction | undefined {
  if (harness.executionEnvironment !== "host-only") {
    return undefined;
  }
  const label = harness.label;
  if (facts.sandboxRequired) {
    return {
      reason: "sandbox-required",
      message:
        label +
        " runs on the Gateway host, but this chat requires a sandbox. Choose another runtime; this requirement cannot be removed.",
    };
  }
  if (facts.remoteExecution) {
    return {
      reason: "remote-execution",
      message:
        label +
        " runs on the Gateway host and cannot use this chat's remote execution environment. Choose another runtime or a local chat.",
    };
  }
  if (facts.workspaceRequired) {
    return {
      reason: "workspace-only",
      message:
        label + " cannot enforce this run's required workspace boundary. Choose another runtime.",
    };
  }
  if (facts.nativeRuntimeConsent === harness.id) {
    return undefined;
  }
  if (facts.workspaceOnly) {
    return {
      reason: "workspace-only",
      message:
        label +
        " cannot enforce this chat's workspace-only file access. Choose another runtime or ask an administrator to review the file-access policy.",
    };
  }
  if (facts.sandboxed) {
    return {
      reason: "sandbox",
      message:
        label +
        " runs on the Gateway host, outside the sandbox. Use its own permissions for this chat, or choose another runtime.",
    };
  }
  if (facts.permissionMode && facts.permissionMode !== "full") {
    return {
      reason: "permission-mode",
      message:
        label +
        " uses its own permissions and requires Full access. Change this chat's permissions explicitly, or choose another runtime.",
    };
  }
  if (facts.toolPolicyRestricted) {
    return {
      reason: "tool-policy",
      message:
        label + " uses its own tools and cannot enforce this chat's OpenClaw tool restrictions.",
    };
  }
  return undefined;
}

/** Classifies stored or prospective session policy without selecting runtime availability. */
export function resolveAgentHarnessSessionExecutionRestriction(params: {
  harness: AgentHarness;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  entry: Pick<
    SessionEntry,
    | "sandbox"
    | "sandboxMode"
    | "createdActor"
    | "permissionMode"
    | "execHost"
    | "nativeRuntimeConsent"
  > & { sessionId?: string };
  provider: string;
  modelId: string;
}): ExecutionRestriction | undefined {
  const { cfg, agentId, sessionKey, entry, harness } = params;
  if (harness.executionEnvironment !== "host-only") {
    return undefined;
  }
  const sandbox = resolveSandboxRuntimeStatus({
    cfg,
    agentId,
    sessionKey,
    preparedSessionEntry: entry,
  });
  const exec = resolveExecConfigState({ cfg, agentId, sessionKey, sessionEntry: entry });
  const nativeRuntimeConsent =
    entry.permissionMode === "full" && entry.sandboxMode === "off"
      ? entry.nativeRuntimeConsent
      : undefined;
  return resolveAgentHarnessExecutionRestriction(harness, {
    sandboxed: sandbox.sandboxed || exec.host === "sandbox",
    sandboxRequired: sandbox.sandboxRequired || exec.host === "sandbox",
    workspaceOnly: resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId }),
    permissionMode: entry.permissionMode,
    nativeRuntimeConsent,
    remoteExecution: exec.host === "node",
    toolPolicyRestricted:
      nativeRuntimeConsent !== harness.id &&
      harness.conversationToolPolicySupport !== "exact" &&
      resolveAgentHarnessNativeToolPolicyRestricted(
        {
          config: cfg,
          agentId,
          sessionKey,
          sessionId: entry.sessionId,
          preparedSessionEntry: entry,
          provider: params.provider,
          modelId: params.modelId,
        },
        harness,
      ),
  });
}

type ExecutionEnvironmentParams = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "agentId"
  | "sessionKey"
  | "sessionId"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "sandbox"
  | "permissionMode"
  | "requireWorkspaceOnly"
  | "execOverrides"
  | "toolsAllow"
  | "disableTools"
  | "swarmCollector"
>;

/** Revalidates execution policy and returns whether this run has native permission consent. */
export function assertAgentHarnessExecutionEnvironment(
  harness: AgentHarness,
  params: ExecutionEnvironmentParams,
): boolean {
  if (harness.executionEnvironment !== "host-only") {
    return false;
  }
  const agentId = resolveSessionAgentId({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const entry = params.sessionKey
    ? resolveSessionEntry(
        {
          agentId,
          sessionKey: params.sessionKey,
          storePath: resolveSessionStorePathCore(params.config?.session?.store, { agentId }),
          clone: false,
        },
        { readOnly: true },
      ).existing
    : undefined;
  // Consent belongs to this incarnation, never a parent or classification session.
  const nativeRuntimeConsent =
    entry?.sessionId === params.sessionId &&
    entry.agentRuntimeOverride === harness.id &&
    entry.permissionMode === "full" &&
    entry.sandboxMode === "off" &&
    !params.disableTools &&
    params.toolsAllow === undefined &&
    !params.swarmCollector
      ? entry.nativeRuntimeConsent
      : undefined;
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: params.sandboxSessionKey,
    classificationAgentId: params.sandboxAgentId,
    ...((!params.sandboxSessionKey || params.sandboxSessionKey === params.sessionKey) &&
    (!params.sandboxAgentId || params.sandboxAgentId === agentId)
      ? { preparedSessionEntry: entry ?? null }
      : {}),
  });
  const exec = resolveExecConfigState({
    cfg: params.config,
    agentId: runtime.classificationAgentId,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
  });
  const restriction = resolveAgentHarnessExecutionRestriction(harness, {
    sandboxed: params.sandbox?.enabled === true || runtime.sandboxed || exec.host === "sandbox",
    nativeRuntimeConsent,
    workspaceRequired: params.requireWorkspaceOnly === true,
    sandboxRequired: runtime.sandboxRequired || exec.host === "sandbox",
    workspaceOnly:
      params.requireWorkspaceOnly === true ||
      resolveEffectiveToolFsWorkspaceOnly({
        cfg: params.config,
        agentId: runtime.classificationAgentId,
      }),
    permissionMode: params.permissionMode,
    remoteExecution: exec.host === "node",
  });
  if (restriction) {
    throw new AgentHarnessPreflightError(restriction.message, {
      scope: "harness",
      userMessage: restriction.message,
    });
  }
  return nativeRuntimeConsent === harness.id;
}

const PLUGIN_HARNESS_SENDER_DENY_ALL_PROMPT =
  "Tool and file actions are disabled for this sender by chat policy. If asked to edit files or use tools, say this sender is not allowed by policy; do not imply retrying will help.";
const PLUGIN_HARNESS_GROUP_DENY_ALL_PROMPT =
  "Tool and file actions are disabled for this chat by policy. If asked to edit files or use tools, say this chat is not allowed by policy.";
const PLUGIN_HARNESS_RUNTIME_DENY_ALL_PROMPT =
  "Tool and file actions are disabled by runtime policy. If asked to edit files or use tools, say tools are disabled by policy.";

type PluginHarnessToolPolicyContext = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "sessionKey"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "agentId"
  | "provider"
  | "modelId"
  | "messageProvider"
  | "messageChannel"
  | "conversationToolPolicy"
  | "spawnedBy"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "memberRoleIds"
  | "agentAccountId"
  | "senderId"
  | "senderName"
  | "senderUsername"
  | "senderE164"
  | "senderIsOwner"
  | "inputProvenance"
  | "trustedInternalHandoff"
  | "scheduledToolPolicy"
  | "runtimePluginToolGrant"
  | "toolsAllow"
  | "disableTools"
  | "swarmCollector"
> & {
  sessionId?: string;
  preparedSessionEntry?: Pick<SessionEntry, "sandbox" | "sandboxMode" | "createdActor"> | null;
};

type PluginHarnessToolPolicy = { allow?: string[]; deny?: string[] };

export type ResolvedPluginHarnessToolPolicies = {
  senderPolicy?: PluginHarnessToolPolicy;
  senderScopedGroupPolicy?: PluginHarnessToolPolicy;
  groupPolicy?: PluginHarnessToolPolicy;
  runtimePolicies: Array<PluginHarnessToolPolicy | undefined>;
  safeDeniedToolNames: string[];
  toolPolicyRestricted: boolean;
};

export function resolvePluginHarnessPolicyToolsAllow(
  params: PluginHarnessToolPolicyContext,
): [] | undefined {
  const policies = resolvePluginHarnessToolPolicies(params);
  return [policies.senderPolicy, policies.groupPolicy, ...policies.runtimePolicies].some(
    toolPolicyRestrictsTools,
  )
    ? []
    : undefined;
}

/** Resolves whether a harness operation must remove its ambient native tool surface. */
export function resolveAgentHarnessNativeToolPolicyRestricted(
  params: PluginHarnessToolPolicyContext,
  harness: AgentHarness,
): boolean {
  return resolvePluginHarnessToolPolicies(
    params,
    harness.conversationToolPolicySupport === "exact"
      ? harness.conversationToolPolicySafeDenyTools
      : undefined,
    harness.conversationToolPolicyNativeTools,
  ).toolPolicyRestricted;
}

export function resolvePluginHarnessDenyAllToolPolicyPrompt(
  policies: ResolvedPluginHarnessToolPolicies,
): string | undefined {
  if (
    policyDeniesAllTools(policies.senderPolicy) ||
    policyDeniesAllTools(policies.senderScopedGroupPolicy)
  ) {
    return PLUGIN_HARNESS_SENDER_DENY_ALL_PROMPT;
  }
  if (policyDeniesAllTools(policies.groupPolicy)) {
    return PLUGIN_HARNESS_GROUP_DENY_ALL_PROMPT;
  }
  return policies.runtimePolicies.some(policyDeniesAllTools)
    ? PLUGIN_HARNESS_RUNTIME_DENY_ALL_PROMPT
    : undefined;
}

export function resolvePluginHarnessToolPolicies(
  params: PluginHarnessToolPolicyContext,
  safeDenyToolNames?: readonly string[],
  nativeToolNames?: readonly string[],
): ResolvedPluginHarnessToolPolicies {
  const messageProvider = params.messageProvider ?? params.messageChannel;
  const sandboxSessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    // Compaction can supply an execution owner without its own session key.
    sessionKey: params.sessionKey ?? (params.agentId ? undefined : sandboxSessionKey),
    classificationSessionKey: sandboxSessionKey,
    classificationAgentId: params.sandboxAgentId,
    preparedSessionEntry: params.preparedSessionEntry,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: params.config,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sandboxSessionKey,
    agentId: params.agentId,
    modelProvider: params.provider,
    modelId: params.modelId,
    messageProvider,
    messageChannel: params.messageChannel,
    conversationToolPolicy: params.conversationToolPolicy,
    agentAccountId: params.agentAccountId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    memberRoleIds: params.memberRoleIds,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    sandboxToolPolicy: sandboxPolicy,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    scheduledToolPolicy: params.scheduledToolPolicy,
    runtimePluginToolGrant: params.runtimePluginToolGrant,
  });
  const callerContext = resolveScheduledToolCallerContext({
    scheduledToolPolicy: params.scheduledToolPolicy,
    channel: messageProvider,
  });
  const groupPolicyParams = {
    config: params.config,
    sessionKey: params.scheduledToolPolicy?.ownerSessionKey ?? params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: callerContext.local ? messageProvider : (callerContext.channel ?? undefined),
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.scheduledToolPolicy?.ownerAccountId ?? params.agentAccountId,
    requireConfiguredAccount: params.scheduledToolPolicy?.mode === "account",
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderPolicyMode: params.scheduledToolPolicy ? ("never" as const) : ("always" as const),
  };
  const { policy } = capabilityProfile;
  // Runtime allowlists treat [] as deny-all; config allow: [] means unrestricted.
  const runtimeRestrictions =
    params.toolsAllow && (readToolAllowlistIntersection(params.toolsAllow) ?? [params.toolsAllow]);
  const requestedToolPolicy =
    params.disableTools || runtimeRestrictions?.some((allow) => allow.length === 0)
      ? { deny: ["*"] }
      : params.toolsAllow
        ? { allow: params.toolsAllow }
        : undefined;
  const explicitPolicies = [
    policy.globalPolicy,
    policy.globalProviderPolicy,
    policy.agentPolicy,
    policy.agentProviderPolicy,
    policy.groupPolicy,
    policy.senderPolicy,
    policy.sandboxPolicy,
    policy.subagentPolicy,
    policy.inheritedToolPolicy,
    policy.runtimeToolPolicyForInheritance,
    requestedToolPolicy,
  ];
  const safeDenyToolNameSet = safeDenyToolNames
    ? new Set(safeDenyToolNames.map(normalizeToolPolicyName))
    : undefined;
  const profilePolicies = [
    mergeAlsoAllowPolicy(policy.profilePolicy, policy.profileAlsoAllow),
    mergeAlsoAllowPolicy(policy.providerProfilePolicy, policy.providerProfileAlsoAllow),
  ];
  return {
    senderPolicy: policy.senderPolicy,
    senderScopedGroupPolicy: resolveSenderScopedGroupToolPolicy(
      params,
      groupPolicyParams,
      policy.groupPolicy,
    ),
    groupPolicy: policy.groupPolicy,
    runtimePolicies: [
      ...profilePolicies,
      policy.globalPolicy,
      policy.globalProviderPolicy,
      policy.agentPolicy,
      policy.agentProviderPolicy,
      sandboxPolicy,
      policy.subagentPolicy,
      policy.inheritedToolPolicy,
      requestedToolPolicy,
    ],
    safeDeniedToolNames: collectHarnessSafeDeniedToolNames(explicitPolicies, safeDenyToolNameSet),
    // Native tools bypass the collector's noninteractive OpenClaw wrappers.
    // Keep policy-allowed host replacements, without ambient input or approval surfaces.
    toolPolicyRestricted:
      params.swarmCollector === true ||
      nativeToolNames?.some((toolName) => !isToolAllowedByPolicies(toolName, profilePolicies)) ===
        true ||
      explicitPolicies.some((explicitPolicy) =>
        toolPolicyRestrictsHarnessNativeTools(explicitPolicy, safeDenyToolNameSet),
      ),
  };
}

function collectHarnessSafeDeniedToolNames(
  policies: Array<PluginHarnessToolPolicy | undefined>,
  safeDenyToolNames: ReadonlySet<string> | undefined,
): string[] {
  if (!safeDenyToolNames) {
    return [];
  }
  return [
    ...new Set(
      policies
        .flatMap((policy) => expandToolGroups(policy?.deny ?? []))
        .map(normalizeToolPolicyName)
        .filter((name) => isKnownCoreToolId(name) && safeDenyToolNames.has(name)),
    ),
  ].toSorted();
}

function toolPolicyRestrictsHarnessNativeTools(
  policy: PluginHarnessToolPolicy | undefined,
  safeDenyToolNames: ReadonlySet<string> | undefined,
): boolean {
  if (!safeDenyToolNames) {
    return toolPolicyRestrictsTools(policy);
  }
  if (!policy || toolPolicyRestrictsTools({ allow: policy.allow })) {
    return toolPolicyRestrictsTools(policy);
  }
  return expandToolGroups(policy.deny ?? []).some((deniedName) => {
    const normalized = normalizeToolPolicyName(deniedName);
    return !isKnownCoreToolId(normalized) || !safeDenyToolNames.has(normalized);
  });
}

function resolveSenderScopedGroupToolPolicy(
  params: PluginHarnessToolPolicyContext,
  groupPolicyParams: Parameters<typeof resolveGroupToolPolicy>[0],
  groupPolicy: { deny?: string[] } | undefined,
): { deny?: string[] } | undefined {
  if (!policyDeniesAllTools(groupPolicy) || !hasSenderIdentity(params)) {
    return undefined;
  }
  const groupPolicyWithoutSender = resolveGroupToolPolicy({
    ...groupPolicyParams,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderE164: undefined,
  });
  return policyDeniesAllTools(groupPolicyWithoutSender) ? undefined : groupPolicy;
}

function hasSenderIdentity(params: PluginHarnessToolPolicyContext): boolean {
  return Boolean(
    params.senderId?.trim() ||
    params.senderName?.trim() ||
    params.senderUsername?.trim() ||
    params.senderE164?.trim(),
  );
}

function policyDeniesAllTools(policy?: { deny?: string[] }): boolean {
  return expandToolGroups(policy?.deny ?? []).some(
    (entry) => normalizeToolPolicyName(entry) === "*",
  );
}
