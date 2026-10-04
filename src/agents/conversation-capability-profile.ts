/**
 * Resolves the conversation-scoped runtime facts that tool and harness policy
 * hot paths share. Keep this internal: it prepares existing config/state, not a
 * new public access-profile config surface.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GroupToolPolicyConfig } from "../config/types.tools.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import { resolveEffectiveToolPolicy, resolveTrustedGroupId } from "./agent-tools.policy.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import {
  resolveScheduledToolCallerContext,
  type ScheduledToolPolicyContext,
} from "./scheduled-tool-policy.js";
import { resolveSessionPlacementSandboxToolPolicy } from "./session-placement-computer.js";
import type { TrustedSubagentCompletionHandoff } from "./subagents/announce/subagent-announce-handoff.js";
import type {
  PreparedSessionCapabilityEntry,
  SessionCapabilityStore,
} from "./subagents/spawn/subagent-capabilities.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "./tool-policy.js";
import { prepareSandboxSessionRename } from "./tools/sessions-operator-authority.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

function resolveManifestToolProfileNames(
  snapshot: Pick<PluginMetadataSnapshot, "plugins"> | undefined,
  profile: string | undefined,
): string[] {
  if (!profile) {
    return [];
  }
  return uniqueStrings(
    (snapshot?.plugins ?? []).flatMap((plugin) =>
      (plugin.contracts?.tools ?? []).filter((toolName) =>
        plugin.toolMetadata?.[toolName]?.profiles?.some((candidate) => candidate === profile),
      ),
    ),
  );
}

export type ConversationCapabilityProfileParams = {
  config?: OpenClawConfig;
  sessionKey?: string;
  /** Live conversation key when a sandbox/policy key is used for tool filtering. */
  runSessionKey?: string;
  /** Session key used for subagent capability inheritance when it differs from sessionKey. */
  sandboxSessionKey?: string;
  /** Owner-read session metadata consumed synchronously during policy preparation. */
  preparedSessionEntry?: PreparedSessionCapabilityEntry;
  /** Complete owner-prepared lineage; no database reads during policy projection. */
  preparedSessionCapabilityStore?: SessionCapabilityStore;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  agentAccountId?: string | null;
  messageProvider?: string | null;
  messageChannel?: string | null;
  conversationToolPolicy?: GroupToolPolicyConfig;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  senderIsOwner?: boolean;
  modelProvider?: string;
  modelId?: string;
  workspaceDir?: string;
  cwd?: string;
  spawnWorkspaceDir?: string;
  sandboxToolPolicy?: SandboxToolPolicy;
  runtimeToolAllowlist?: string[];
  /** Persist the runtime allowlist as real parent authority on spawned children. */
  inheritRuntimeToolAllowlist?: boolean;
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  inputProvenance?: InputProvenance;
  /** Consumed in-process completion capability; public callers cannot set this fact. */
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  /** Trusted server-stamped authority for an explicitly capped scheduled run. */
  scheduledToolPolicy?: ScheduledToolPolicyContext;
};

export function resolveConversationCapabilityProfile(params: ConversationCapabilityProfileParams) {
  const messageProvider = params.messageProvider;
  const effective = resolveEffectiveToolPolicy(params);
  const { policy: sandboxToolPolicy, renameOnly: sandboxSessionRenameOnly } =
    prepareSandboxSessionRename({
      policy: resolveSessionPlacementSandboxToolPolicy(params.sandboxToolPolicy, {
        runId: params.runId,
        agentId: effective.agentId,
      }),
      senderIsOwner: params.senderIsOwner,
    });
  const trustedGroup = resolveTrustedGroupId({
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    groupId: params.groupId,
  });
  // Group channel/space labels have no session-bound counterpart to verify
  // against; mask them whenever the trust check dropped the caller group id.
  const trustedGroupChannel = trustedGroup.dropped ? null : params.groupChannel;
  const trustedGroupSpace = trustedGroup.dropped ? null : params.groupSpace;
  // Owner WebChat intentionally has no external sender identity. Its trusted
  // owner state must not fall through to the wildcard policy for guests.
  const isOwnerInternalSession =
    params.senderIsOwner === true &&
    normalizeMessageChannel(messageProvider ?? params.messageChannel) === INTERNAL_MESSAGE_CHANNEL;
  const subagentSessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const callerContext = resolveScheduledToolCallerContext({
    scheduledToolPolicy: params.scheduledToolPolicy,
    channel: messageProvider ?? undefined,
  });
  const requesterPolicies = resolveRequesterToolPolicies({
    ...params,
    subagentSessionKey,
    agentId: effective.agentId,
    messageProvider: callerContext.local ? messageProvider : callerContext.channel,
    groupId: trustedGroup.groupId,
    groupChannel: trustedGroupChannel,
    groupSpace: trustedGroupSpace,
    accountId: params.scheduledToolPolicy?.ownerAccountId ?? params.agentAccountId,
    senderPolicyMode: params.scheduledToolPolicy || isOwnerInternalSession ? "never" : "always",
    groupPolicySessionKey: params.scheduledToolPolicy?.ownerSessionKey,
    requireConfiguredGroupAccount: params.scheduledToolPolicy?.mode === "account",
    conversationPolicy: pickSandboxToolPolicy(params.conversationToolPolicy),
  });
  const { groupPolicy, senderPolicy, subagentPolicy, inheritedToolPolicy } = requesterPolicies;
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(effective.profile),
    resolveManifestToolProfileNames(params.pluginMetadataSnapshot, effective.profile),
  );
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(effective.providerProfile),
    resolveManifestToolProfileNames(params.pluginMetadataSnapshot, effective.providerProfile),
  );
  const configuredOverridePolicies = [
    effective.globalPolicy,
    effective.globalProviderPolicy,
    effective.agentPolicy,
    effective.agentProviderPolicy,
    groupPolicy,
    senderPolicy,
    sandboxToolPolicy,
    subagentPolicy,
  ];
  const runtimeToolPolicy = params.runtimeToolAllowlist
    ? { allow: params.runtimeToolAllowlist }
    : undefined;
  const runtimeToolPolicyForInheritance =
    params.inheritRuntimeToolAllowlist === true ? runtimeToolPolicy : undefined;
  const runtimeToolAlsoAllowlist = uniqueStrings(
    (params.runtimePluginToolGrant?.toolNames ?? []).map((entry) => entry.trim()).filter(Boolean),
  );
  const mergeRuntimeToolAlsoAllowlist = (configured?: string[]) => {
    const merged = uniqueStrings([...(configured ?? []), ...runtimeToolAlsoAllowlist]);
    return merged.length > 0 ? merged : undefined;
  };
  const explicitOverridePolicies = [...configuredOverridePolicies, runtimeToolPolicy];
  const explicitToolAllowlistPolicies = [
    profilePolicy,
    providerProfilePolicy,
    ...configuredOverridePolicies,
    inheritedToolPolicy,
    runtimeToolPolicy,
  ];
  const inheritancePolicies = [
    profilePolicy,
    providerProfilePolicy,
    ...configuredOverridePolicies,
    inheritedToolPolicy,
    runtimeToolPolicyForInheritance,
  ];

  return {
    agentId: effective.agentId,
    serviceIdentity: {
      accountId: params.agentAccountId,
    },
    model: {
      provider: params.modelProvider,
      id: params.modelId,
    },
    conversation: {
      sessionKey: params.runSessionKey ?? params.sessionKey,
      policySessionKey: params.sessionKey,
      runSessionKey: params.runSessionKey,
      sessionId: params.sessionId,
      messageProvider,
      messageChannel: params.messageChannel,
      groupId: trustedGroup.groupId,
      groupChannel: trustedGroupChannel,
      groupSpace: trustedGroupSpace,
      spawnedBy: params.spawnedBy,
    },
    sender: {
      isOwner: params.senderIsOwner,
    },
    workspace: {
      workspaceRoot: resolveWorkspaceRoot(params.workspaceDir),
      runtimeRoot: resolveWorkspaceRoot(params.cwd ?? params.workspaceDir),
      spawnWorkspaceRoot: params.spawnWorkspaceDir
        ? resolveWorkspaceRoot(params.spawnWorkspaceDir)
        : undefined,
    },
    policy: {
      ...effective,
      sessionKey: params.sessionKey,
      subagentSessionKey,
      trustedGroup,
      profilePolicy,
      providerProfilePolicy,
      profileAlsoAllow: mergeRuntimeToolAlsoAllowlist(effective.profileAlsoAllow),
      providerProfileAlsoAllow: mergeRuntimeToolAlsoAllowlist(effective.providerProfileAlsoAllow),
      groupPolicy,
      senderPolicy,
      sandboxPolicy: sandboxToolPolicy,
      sandboxSessionRenameOnly,
      subagentPolicy,
      inheritedToolPolicy,
      delegated: requesterPolicies.delegated,
      requesterPolicySource: requesterPolicies.requesterPolicySource,
      runtimeToolPolicyForInheritance,
      inheritancePolicies,
      explicitToolAllowlist: collectExplicitAllowlist(explicitToolAllowlistPolicies),
      explicitToolOverrideAllowlist: collectExplicitAllowlist(explicitOverridePolicies),
      explicitToolDenylist: collectExplicitDenylist(explicitToolAllowlistPolicies),
      runtimePluginToolGrant: params.runtimePluginToolGrant,
    },
  };
}

export type ResolvedConversationCapabilityProfile = ReturnType<
  typeof resolveConversationCapabilityProfile
>;
