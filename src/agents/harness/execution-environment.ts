import type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { AgentRuntimeRestrictionErrorDetails } from "../../../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js";
import { hasRememberedNativeRuntimeConsent } from "../../config/native-runtime-consent.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../../config/sessions/session-actor-storage-binding.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { isHostScopedAgentToolActive } from "../agent-tools.ring-zero-context.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { resolveExecConfigState } from "../exec-defaults.js";
import { resolveRequesterConversationToolPolicy } from "../requester-tool-policy.js";
import {
  resolveSandboxRuntimeStatus,
  withSandboxRuntimeStatusInWorker,
} from "../sandbox/runtime-status.js";
import { resolveScheduledToolCallerContext } from "../scheduled-tool-policy.js";
import {
  withPreparedSessionCapabilityRead,
  type PreparedSessionCapabilityEntry,
  type SessionCapabilitySnapshot,
} from "../subagents/spawn/subagent-session-store.js";
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
import { resolveWebSearchToolPolicy } from "../web-search-tool-policy.js";
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
  const consented = facts.nativeRuntimeConsent === harness.id;
  const restrictions: Array<
    [applies: boolean | undefined, reason: ExecutionRestriction["reason"], message: string]
  > = [
    [
      facts.sandboxRequired,
      "sandbox-required",
      " runs on the Gateway host, but this chat requires a sandbox. Choose another runtime; this requirement cannot be removed.",
    ],
    [
      facts.remoteExecution,
      "remote-execution",
      " runs on the Gateway host and cannot use this chat's remote execution environment. Choose another runtime or a local chat.",
    ],
    [
      facts.workspaceRequired,
      "workspace-only",
      " cannot enforce this run's required workspace boundary. Choose another runtime.",
    ],
    [
      !consented && facts.workspaceOnly,
      "workspace-only",
      " cannot enforce this chat's workspace-only file access. Choose another runtime or ask an administrator to review the file-access policy.",
    ],
    [
      !consented && facts.sandboxed,
      "sandbox",
      " runs on the Gateway host, outside the sandbox. Use its own permissions for this chat, or choose another runtime.",
    ],
    [
      !consented && Boolean(facts.permissionMode && facts.permissionMode !== "full"),
      "permission-mode",
      " uses its own permissions and requires Full access. Change this chat's permissions explicitly, or choose another runtime.",
    ],
    [
      !consented && facts.toolPolicyRestricted,
      "tool-policy",
      " uses its own tools and cannot enforce this chat's OpenClaw tool restrictions.",
    ],
  ];
  const restriction = restrictions.find(([applies]) => applies);
  return restriction ? { reason: restriction[1], message: label + restriction[2] } : undefined;
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
  preparedSessionCapabilityEntry?: PreparedSessionCapabilityEntry;
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
      ? (entry.nativeRuntimeConsent ??
        (hasRememberedNativeRuntimeConsent(cfg, agentId, harness.id) ? harness.id : undefined))
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
          preparedSessionCapabilityEntry: params.preparedSessionCapabilityEntry,
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
export async function assertAgentHarnessExecutionEnvironment(
  harness: AgentHarness,
  params: ExecutionEnvironmentParams,
): Promise<boolean> {
  if (harness.executionEnvironment !== "host-only") {
    return false;
  }
  const agentId = resolveSessionAgentId({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const source = params.sessionKey
    ? captureSessionActorStorageOwner(
        {
          agentId,
          sessionKey: params.sessionKey,
          storePath: params.config?.session?.store
            ? resolveSessionStorePathCore(params.config.session.store, { agentId })
            : undefined,
        },
        { assertCurrent() {}, authorize() {} },
      )
    : undefined;
  const entry = source
    ? readCapturedSessionActorEntry(source, params.sessionKey!)
    : params.sessionKey
      ? await readSessionEntryReadOnlyInWorker({
          agentId,
          sessionKey: params.sessionKey,
          storePath: resolveSessionStorePathCore(params.config?.session?.store, { agentId }),
        })
      : undefined;
  const runtimeParams = {
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: params.sandboxSessionKey,
    classificationAgentId: params.sandboxAgentId,
  };
  if (
    (!params.sandboxSessionKey || params.sandboxSessionKey === params.sessionKey) &&
    (!params.sandboxAgentId || params.sandboxAgentId === agentId)
  ) {
    return assertPreparedAgentHarnessExecutionEnvironment(
      harness,
      params,
      entry,
      source !== undefined,
      resolveSandboxRuntimeStatus({ ...runtimeParams, preparedSessionEntry: entry ?? null }),
    );
  }
  return withSandboxRuntimeStatusInWorker(
    runtimeParams,
    { env: process.env, cwd: process.cwd(), assertCurrent() {} },
    async (runtime) =>
      assertPreparedAgentHarnessExecutionEnvironment(
        harness,
        params,
        entry,
        source !== undefined,
        runtime,
      ),
  );
}

function assertPreparedAgentHarnessExecutionEnvironment(
  harness: AgentHarness,
  params: ExecutionEnvironmentParams,
  entry:
    | Pick<
        SessionEntry,
        | "sessionId"
        | "agentRuntimeOverride"
        | "permissionMode"
        | "sandbox"
        | "sandboxMode"
        | "createdActor"
        | "execHost"
        | "execNode"
        | "execCwd"
        | "nativeRuntimeConsent"
      >
    | undefined,
  nativeSource: boolean,
  runtime: ReturnType<typeof resolveSandboxRuntimeStatus>,
): boolean {
  const remembered = hasRememberedNativeRuntimeConsent(
    params.config,
    resolveSessionAgentId({
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }),
    harness.id,
  );
  // Per-chat consent belongs to this incarnation; agent consent authorizes the selected harness.
  const nativeRuntimeConsent =
    entry?.sessionId === params.sessionId &&
    (entry.agentRuntimeOverride === harness.id || remembered) &&
    entry.permissionMode === "full" &&
    params.permissionMode === "full" &&
    !params.sandbox?.enabled &&
    entry.sandboxMode === "off" &&
    !params.disableTools &&
    params.toolsAllow === undefined &&
    !params.swarmCollector
      ? remembered
        ? harness.id
        : entry.nativeRuntimeConsent
      : undefined;
  const exec = resolveExecConfigState({
    cfg: params.config,
    agentId: runtime.classificationAgentId,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
    sessionEntry: nativeSource ? entry : undefined,
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
    permissionMode:
      nativeSource && params.permissionMode === "full" && entry?.sessionId === params.sessionId
        ? (entry.permissionMode ?? params.permissionMode)
        : params.permissionMode,
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
  | "sandbox"
  | "agentId"
  | "provider"
  | "modelId"
  | "messageProvider"
  | "messageChannel"
  | "conversationToolPolicy"
  | "requesterOrigin"
  | "operatorProfileId"
  | "conversationId"
  | "chatType"
  | "messageThreadId"
  | "memberRoleIds"
  | "spawnedBy"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
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
  preparedSessionCapabilityEntry?: PreparedSessionCapabilityEntry;
};

type PluginHarnessToolPolicy = { allow?: string[]; deny?: string[] };

export type ResolvedPluginHarnessToolPolicies = {
  webSearchPolicy?: EmbeddedRunAttemptParams["preparedWebSearchPolicy"];
  senderPolicy?: PluginHarnessToolPolicy;
  senderScopedGroupPolicy?: PluginHarnessToolPolicy;
  groupPolicy?: PluginHarnessToolPolicy;
  runtimePolicies: Array<PluginHarnessToolPolicy | undefined>;
  safeDeniedToolNames: string[];
  requiresLiveToolAuthority: boolean;
  toolPolicyScope: "conversation" | "turn";
  toolPolicyRestricted: boolean;
};

export function resolvePluginHarnessPolicyToolsAllow(
  policies: ResolvedPluginHarnessToolPolicies,
): [] | undefined {
  return [policies.senderPolicy, policies.groupPolicy, ...policies.runtimePolicies].some(
    toolPolicyRestrictsTools,
  )
    ? []
    : undefined;
}

export async function prepareAgentHarnessNativeToolPolicyRestricted(
  params: PluginHarnessToolPolicyContext,
  harness: AgentHarness,
): Promise<boolean> {
  const policies = await preparePluginHarnessToolPolicies(
    params,
    harness.conversationToolPolicySupport === "exact"
      ? harness.conversationToolPolicySafeDenyTools
      : undefined,
    harness.conversationToolPolicyNativeTools,
  );
  return policies.toolPolicyRestricted;
}

export async function preparePluginHarnessToolPolicies(
  params: PluginHarnessToolPolicyContext,
  safeDenyToolNames?: readonly string[],
  nativeToolNames?: readonly string[],
  webSearchModel?: ModelRef | null,
): Promise<ResolvedPluginHarnessToolPolicies> {
  const consume = (sandbox: ReturnType<typeof resolveSandboxRuntimeStatus>) => {
    const requesterFacts = new Map<string, SessionCapabilitySnapshot>();
    return withPreparedSessionCapabilityRead(
      () => {
        requesterFacts.clear();
        const policies = resolvePluginHarnessToolPolicies(
          params,
          safeDenyToolNames,
          nativeToolNames,
          sandbox,
        );
        const webSearchPolicy = webSearchModel
          ? resolveWebSearchToolPolicy({
              ...params,
              modelProvider: webSearchModel.provider,
              modelId: webSearchModel.model,
              // An independent policy session can belong to another agent than the execution.
              agentId: sandbox.classificationAgentId,
              sessionKey: sandbox.classificationSessionKey || params.sessionId,
              messageProvider: params.messageChannel ?? params.messageProvider,
              sandboxToolPolicy:
                params.sandbox !== undefined
                  ? params.sandbox?.tools
                  : sandbox.sandboxed
                    ? sandbox.toolPolicy
                    : undefined,
            })
          : undefined;
        return {
          ...policies,
          webSearchPolicy:
            webSearchModel === null
              ? { allowed: false, persistentAllowed: false }
              : webSearchPolicy && {
                  ...webSearchPolicy,
                  modelRef: webSearchModel,
                  requesterFacts: [...requesterFacts.values()],
                },
        };
      },
      {
        onRead: webSearchModel
          ? (snapshot) => requesterFacts.set(JSON.stringify(snapshot.query), snapshot)
          : undefined,
      },
    );
  };
  const runtimeParams = {
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey ?? (params.agentId ? undefined : params.sandboxSessionKey),
    classificationSessionKey: params.sandboxSessionKey ?? params.sessionKey,
    classificationAgentId: params.sandboxAgentId,
  };
  if (params.preparedSessionEntry !== undefined) {
    return consume(
      resolveSandboxRuntimeStatus({
        ...runtimeParams,
        preparedSessionEntry: params.preparedSessionEntry,
      }),
    );
  }
  return withSandboxRuntimeStatusInWorker(
    runtimeParams,
    { env: process.env, cwd: process.cwd(), assertCurrent() {} },
    consume,
  );
}

/** Resolves whether a harness operation must remove its ambient native tool surface. */
function resolveAgentHarnessNativeToolPolicyRestricted(
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
  const sources = [
    [
      [policies.senderPolicy, policies.senderScopedGroupPolicy],
      PLUGIN_HARNESS_SENDER_DENY_ALL_PROMPT,
    ],
    [[policies.groupPolicy], PLUGIN_HARNESS_GROUP_DENY_ALL_PROMPT],
    [policies.runtimePolicies, PLUGIN_HARNESS_RUNTIME_DENY_ALL_PROMPT],
  ] as const;
  return sources.find(([candidates]) => candidates.some(policyDeniesAllTools))?.[1];
}

export function resolvePluginHarnessToolPolicies(
  params: PluginHarnessToolPolicyContext,
  safeDenyToolNames?: readonly string[],
  nativeToolNames?: readonly string[],
  preparedSandbox?: ReturnType<typeof resolveSandboxRuntimeStatus>,
): ResolvedPluginHarnessToolPolicies {
  const messageProvider = params.messageProvider ?? params.messageChannel;
  const sandboxSessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const sandboxRuntime =
    preparedSandbox ??
    resolveSandboxRuntimeStatus({
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
    preparedSessionEntry: params.preparedSessionCapabilityEntry,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sandboxSessionKey,
    agentId: params.agentId,
    modelProvider: params.provider,
    modelId: params.modelId,
    messageProvider,
    messageChannel: params.messageChannel,
    conversationToolPolicy: params.conversationToolPolicy,
    requesterOrigin: params.requesterOrigin,
    operatorProfileId: params.operatorProfileId,
    conversationId: params.conversationId,
    chatType: params.chatType,
    messageThreadId: params.messageThreadId,
    memberRoleIds: params.memberRoleIds,
    agentAccountId: params.agentAccountId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
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
    requesterOrigin: params.requesterOrigin,
    conversationId: params.conversationId,
    chatType: params.chatType,
    config: params.config,
    sessionKey: params.scheduledToolPolicy?.ownerSessionKey ?? params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: callerContext.local ? messageProvider : (callerContext.channel ?? undefined),
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.scheduledToolPolicy?.ownerAccountId ?? params.agentAccountId,
    requireConfiguredGroupAccount: params.scheduledToolPolicy?.mode === "account",
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
  const systemAgentOnlyAllowlist =
    isHostScopedAgentToolActive("openclaw") && isSystemAgentOnlyAllowlist(params.toolsAllow);
  const senderScopedGroupPolicy = resolveSenderScopedGroupToolPolicy(
    params,
    groupPolicyParams,
    policy.groupPolicy,
  );
  return {
    // A no-op wildcard policy does not change lifetime; additive grants still do.
    toolPolicyScope:
      params.disableTools ||
      (!systemAgentOnlyAllowlist && toolPolicyRestrictsTools(requestedToolPolicy)) ||
      (params.scheduledToolPolicy?.mode === "account" &&
        (explicitPolicies.some(toolPolicyRestrictsTools) ||
          profilePolicies.some(toolPolicyRestrictsTools))) ||
      params.runtimePluginToolGrant !== undefined ||
      // A persisted delegation floor still requires this turn's live grant projection.
      Boolean(policy.delegatedToolPolicy) ||
      params.swarmCollector === true ||
      toolPolicyRestrictsTools(policy.senderPolicy) ||
      toolPolicyRestrictsTools(senderScopedGroupPolicy)
        ? "turn"
        : "conversation",
    senderPolicy: policy.senderPolicy,
    senderScopedGroupPolicy,
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
    requiresLiveToolAuthority: Boolean(policy.delegatedToolPolicy),
    // Native tools bypass the collector's noninteractive OpenClaw wrappers.
    // Keep policy-allowed host replacements, without ambient input or approval surfaces.
    toolPolicyRestricted:
      // Delegated tools require OpenClaw’s live pre-effect grant checks.
      Boolean(policy.delegatedToolPolicy) ||
      params.swarmCollector === true ||
      nativeToolNames?.some((toolName) => !isToolAllowedByPolicies(toolName, profilePolicies)) ===
        true ||
      explicitPolicies.some((explicitPolicy) =>
        toolPolicyRestrictsHarnessNativeTools(explicitPolicy, safeDenyToolNameSet),
      ),
  };
}

export function isSystemAgentOnlyAllowlist(toolsAllow: readonly string[] | undefined): boolean {
  return toolsAllow?.length === 1 && normalizeToolPolicyName(toolsAllow[0] ?? "") === "openclaw";
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
  if (!safeDenyToolNames || !policy || toolPolicyRestrictsTools({ allow: policy.allow })) {
    return toolPolicyRestrictsTools(policy);
  }
  return expandToolGroups(policy.deny ?? []).some((deniedName) => {
    const normalized = normalizeToolPolicyName(deniedName);
    return !isKnownCoreToolId(normalized) || !safeDenyToolNames.has(normalized);
  });
}

function resolveSenderScopedGroupToolPolicy(
  params: PluginHarnessToolPolicyContext,
  groupPolicyParams: Parameters<typeof resolveRequesterConversationToolPolicy>[0],
  groupPolicy: { deny?: string[] } | undefined,
): { deny?: string[] } | undefined {
  if (!policyDeniesAllTools(groupPolicy) || !hasSenderIdentity(params)) {
    return undefined;
  }
  const groupPolicyWithoutSender = resolveRequesterConversationToolPolicy({
    ...groupPolicyParams,
    requesterOrigin: params.requesterOrigin
      ? {
          ...params.requesterOrigin,
          senderId: undefined,
          senderName: undefined,
          senderUsername: undefined,
          senderE164: undefined,
        }
      : undefined,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderE164: undefined,
  });
  return policyDeniesAllTools(groupPolicyWithoutSender) ? undefined : groupPolicy;
}

function hasSenderIdentity(params: PluginHarnessToolPolicyContext): boolean {
  const requester = params.requesterOrigin ?? params;
  return Boolean(
    requester.senderId?.trim() ||
    requester.senderName?.trim() ||
    requester.senderUsername?.trim() ||
    requester.senderE164?.trim(),
  );
}

function policyDeniesAllTools(policy?: { deny?: string[] }): boolean {
  return expandToolGroups(policy?.deny ?? []).some(
    (entry) => normalizeToolPolicyName(entry) === "*",
  );
}
