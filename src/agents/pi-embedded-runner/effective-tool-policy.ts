import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginToolMeta } from "../../plugins/tools.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupContextFromSessionKey,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "../pi-tools.policy.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../tool-policy-pipeline.js";
import {
  applyOwnerOnlyToolPolicy,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../tool-policy.js";
import type { AnyAgentTool } from "../tools/common.js";

/**
 * Identity inputs used by `resolveGroupToolPolicy` to look up channel/group
 * tool policy. These fields are an authorization signal (they can widen
 * bundled-tool availability via a group-scoped allowlist), so callers MUST
 * pass values derived from server-verified session metadata (session key,
 * inbound transport event), not from tool-call or model-controlled input.
 * The helper cross-checks caller-provided `groupId` against session-derived
 * group ids and drops the caller value when they disagree, but it cannot
 * detect drift on fields that have no session-bound counterpart.
 */
type FinalEffectiveToolPolicyParams = {
  // Tools appended to the core tool set after `createOpenClawCodingTools()`
  // has already applied owner-only and tool-policy filtering (e.g. bundled
  // MCP/LSP tools). Only these are filtered here; re-running the pipeline over
  // the already-filtered core tools would drop plugin tools whose WeakMap
  // metadata no longer survives core-tool wrapping/normalization.
  bundledTools: AnyAgentTool[];
  config?: OpenClawConfig;
  sandboxToolPolicy?: { allow?: string[]; deny?: string[] };
  sessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  senderIsOwner?: boolean;
  warn: (message: string) => void;
};

function resolveTrustedGroupId(params: FinalEffectiveToolPolicyParams): {
  groupId: string | null | undefined;
  dropped: boolean;
} {
  const callerGroupId = (params.groupId ?? "").trim();
  if (!callerGroupId) {
    return { groupId: params.groupId, dropped: false };
  }
  const sessionGroupIds = resolveGroupContextFromSessionKey(params.sessionKey).groupIds ?? [];
  const spawnedGroupIds = resolveGroupContextFromSessionKey(params.spawnedBy).groupIds ?? [];
  const trusted = [...sessionGroupIds, ...spawnedGroupIds];
  if (trusted.length === 0) {
    return { groupId: params.groupId, dropped: false };
  }
  if (trusted.includes(callerGroupId)) {
    return { groupId: params.groupId, dropped: false };
  }
  return { groupId: null, dropped: true };
}

export function applyFinalEffectiveToolPolicy(
  params: FinalEffectiveToolPolicyParams,
): AnyAgentTool[] {
  if (params.bundledTools.length === 0) {
    return params.bundledTools;
  }
  const trustedGroup = resolveTrustedGroupId(params);
  if (trustedGroup.dropped) {
    params.warn(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  }
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });

  const groupPolicy = resolveGroupToolPolicy({
    config: params.config,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: params.messageProvider,
    groupId: trustedGroup.groupId,
    groupChannel: trustedGroup.dropped ? null : params.groupChannel,
    groupSpace: trustedGroup.dropped ? null : params.groupSpace,
    accountId: params.agentAccountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const subagentPolicy =
    isSubagentSessionKey(params.sessionKey) && params.sessionKey
      ? resolveSubagentToolPolicyForSession(params.config, params.sessionKey)
      : undefined;
  const ownerFiltered = applyOwnerOnlyToolPolicy(params.bundledTools, params.senderIsOwner === true);
  return applyToolPolicyPipeline({
    tools: ownerFiltered,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: params.warn,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy: profilePolicyWithAlsoAllow,
        profile,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
        providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
        providerProfile,
        providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        agentId,
      }),
      { policy: params.sandboxToolPolicy, label: "sandbox tools.allow" },
      { policy: subagentPolicy, label: "subagent tools.allow" },
    ],
  });
}
