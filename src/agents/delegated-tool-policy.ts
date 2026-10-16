import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRuntimeConfigReader } from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { listAgentIds, resolveAgentConfig } from "./agent-scope.js";
import { normalizeInheritedToolDenylist } from "./inherited-tool-deny.js";
import { resolveSubagentTargetPolicy } from "./subagents/spawn/subagent-target-policy.js";
import { hasRestrictiveAllowPolicy } from "./tool-policy.js";

export type DelegatedToolPolicy = NonNullable<SessionEntry["delegatedToolPolicy"]>;
export type DelegatedToolPolicyContext = {
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  /** Prepared by the host before policy flattening; never accepted from tool arguments. */
  delegatedToolDenyFloor?: DelegatedToolDenyFloor;
  /** Immediate requester execution snapshot; ordinary inherited denies retain revocation fallback. */
  requesterToolDenylist?: string[];
  /** Bound at tool construction so an awaited spawn cannot pin a superseded runtime config. */
  readDelegationConfig?: () => OpenClawConfig;
  /** A mediated producer cannot export its active native delegation exception. */
  delegatedToolPolicyUnavailable?: boolean;
  /** Restrictive requester policy originated at trusted sender/channel ingress. */
  inheritedToolPolicySource?: "sender";
};

export type DelegatedToolDenyFloor = {
  policyAgentId: string;
  deny: string[];
  continuation?: Pick<DelegatedToolPolicy, "requesterSessionKey" | "targetAgentId">;
};

function hasCurrentDelegationGrant(
  config: OpenClawConfig,
  requesterSessionKey: string,
  targetAgentId: string,
): boolean {
  const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  if (!requesterAgentId || requesterAgentId === targetAgentId) {
    return false;
  }
  const requester = resolveAgentConfig(config, requesterAgentId)?.subagents;
  // This exact per-agent grant has no wildcard or global-default fallback.
  if (!requester?.delegateToolsTo?.includes(targetAgentId)) {
    return false;
  }
  return resolveSubagentTargetPolicy({
    requesterAgentId,
    targetAgentId,
    requestedAgentId: targetAgentId,
    allowAgents: requester.allowAgents ?? config.agents?.defaults?.subagents?.allowAgents,
    configuredAgentIds: listAgentIds(config),
  }).ok;
}

/** The creation owner composes this with its existing synchronous pre-commit assertion. */
export function captureDelegatedToolPolicyAssertion(
  config: OpenClawConfig,
  policy: DelegatedToolPolicy | undefined,
  readConfig = createRuntimeConfigReader(config),
): (() => void) | undefined {
  if (!policy) {
    return undefined;
  }
  return () => {
    if (
      !hasCurrentDelegationGrant(readConfig(), policy.requesterSessionKey, policy.targetAgentId)
    ) {
      throw new Error("Delegated tool target authorization changed.");
    }
  };
}

/** Only trusted native spawn callers receive the separately prepared deny floor. */
export function selectDelegatedToolPolicy(params: {
  config: OpenClawConfig;
  requesterSessionKey: string;
  requesterAgentId: string;
  targetAgentId: string;
  floor?: DelegatedToolDenyFloor;
  requesterToolDenylist?: readonly string[];
  inheritedToolAllowlist?: readonly string[];
  inheritedToolPolicySource?: "sender";
}): DelegatedToolPolicy | undefined {
  const continuation = params.floor?.continuation;
  const requesterSessionKey = continuation?.requesterSessionKey ?? params.requesterSessionKey;
  if (
    params.inheritedToolPolicySource === "sender" ||
    (continuation &&
      (params.requesterAgentId !== continuation.targetAgentId ||
        params.targetAgentId !== continuation.targetAgentId)) ||
    !hasCurrentDelegationGrant(params.config, requesterSessionKey, params.targetAgentId)
  ) {
    return undefined;
  }
  if (
    !params.floor ||
    (!continuation &&
      hasRestrictiveAllowPolicy({ allow: [...(params.inheritedToolAllowlist ?? [])] }))
  ) {
    throw new Error(
      "Delegated tool target requires a host-prepared deny-only policy. Restrictive profiles, allowlists, and this transport’s unavailable delegation projection cannot be widened; use a deny-only native requester or remove delegateToolsTo for ordinary capped helpers.",
    );
  }
  if (params.floor.policyAgentId !== params.requesterAgentId) {
    throw new Error(
      "Delegated tool policy owner differs from the executing requester; borrowed restrictions cannot be waived.",
    );
  }
  return {
    requesterSessionKey,
    targetAgentId: params.targetAgentId,
    deny: [...params.floor.deny],
    requesterDeny: normalizeInheritedToolDenylist(params.requesterToolDenylist),
  };
}

/** Select and bind one native handoff before either spawn adapter awaits preparation. */
export function prepareNativeDelegatedToolPolicy(params: {
  config: OpenClawConfig;
  requesterSessionKey: string;
  requesterAgentId: string;
  targetAgentId: string;
  context?: DelegatedToolPolicyContext;
}) {
  const context = params.context;
  const policy = selectDelegatedToolPolicy({
    ...params,
    floor: context?.delegatedToolDenyFloor,
    requesterToolDenylist: context?.requesterToolDenylist ?? context?.inheritedToolDenylist,
    inheritedToolAllowlist: context?.inheritedToolAllowlist,
    inheritedToolPolicySource: context?.inheritedToolPolicySource,
  });
  return {
    policy,
    assertCurrent: captureDelegatedToolPolicyAssertion(
      params.config,
      policy,
      context?.readDelegationConfig,
    ),
  };
}

/** Malformed/legacy facts never manufacture an exception to the ordinary snapshot. */
export function readDelegatedToolPolicy(value: unknown): DelegatedToolPolicy | undefined {
  if (
    !isRecord(value) ||
    typeof value.requesterSessionKey !== "string" ||
    !parseAgentSessionKey(value.requesterSessionKey) ||
    typeof value.targetAgentId !== "string" ||
    !Array.isArray(value.deny) ||
    value.deny.some((entry) => typeof entry !== "string") ||
    !Array.isArray(value.requesterDeny) ||
    value.requesterDeny.some((entry) => typeof entry !== "string") ||
    Object.keys(value).some(
      (key) => !["requesterSessionKey", "targetAgentId", "deny", "requesterDeny"].includes(key),
    )
  ) {
    return undefined;
  }
  return {
    requesterSessionKey: value.requesterSessionKey,
    targetAgentId: value.targetAgentId,
    deny: normalizeInheritedToolDenylist(value.deny),
    requesterDeny: normalizeInheritedToolDenylist(value.requesterDeny),
  };
}

/** Lineage is verified by the envelope owner; current config still owns the exception. */
export function resolveDelegatedExecutionToolPolicy(params: {
  config?: OpenClawConfig;
  sessionKey: string;
  inheritedToolAllow: string[];
  inheritedToolPolicySource?: "sender";
  delegatedToolPolicy?: DelegatedToolPolicy;
}): { allow?: string[]; deny: string[] } | undefined {
  const floor = params.delegatedToolPolicy;
  const child = parseAgentSessionKey(params.sessionKey);
  if (
    !params.config ||
    !floor ||
    params.inheritedToolPolicySource === "sender" ||
    !child ||
    !(child.rest.startsWith("subagent:") || child.rest.startsWith("dashboard:")) ||
    child.agentId !== floor.targetAgentId ||
    !hasCurrentDelegationGrant(params.config, floor.requesterSessionKey, floor.targetAgentId)
  ) {
    return undefined;
  }
  return {
    ...(params.inheritedToolAllow.length ? { allow: [...params.inheritedToolAllow] } : {}),
    deny: [...floor.deny],
  };
}
