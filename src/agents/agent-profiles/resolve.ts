import type { AgentProfileCommon } from "agentprofiles";
import type { AgentProfileId, AgentProfileSelector } from "../../config/agent-profile-ids.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveAgentConfig } from "../agent-scope-config.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { BUILT_IN_AGENT_PROFILES, type BuiltInAgentProfile } from "./builtins.js";
import {
  resolveOpenClawAgentProfileExtension,
  type OpenClawAgentProfileExtension,
} from "./openclaw-extension.js";

type AgentProfileSelectionSource = "agent-explicit" | "defaults-explicit" | "fallback";

type ResolvedBuiltInAgentProfile = {
  id: AgentProfileId;
  ancestry: readonly AgentProfileId[];
  spec: {
    common: AgentProfileCommon;
    "openclaw.ai"?: OpenClawAgentProfileExtension;
  };
};

export type ResolvedAgentProfile = {
  profile: ResolvedBuiltInAgentProfile;
  selectionSource: AgentProfileSelectionSource;
};

const profilesById = new Map<string, BuiltInAgentProfile>(
  BUILT_IN_AGENT_PROFILES.map((profile) => [profile.id, profile]),
);
const resolvedProfilesById = new Map<AgentProfileId, ResolvedBuiltInAgentProfile>();

function resolveBuiltInProfileAncestry(
  profileId: AgentProfileId,
  active: readonly AgentProfileId[] = [],
): readonly BuiltInAgentProfile[] {
  if (active.includes(profileId)) {
    throw new Error(`Agent Profile inheritance cycle: ${[...active, profileId].join(" -> ")}`);
  }
  const profile = profilesById.get(profileId);
  if (!profile) {
    throw new Error(`Unknown built-in Agent Profile: ${profileId}`);
  }
  const parentId = profile.resource.extends;
  if (!parentId) {
    return [profile];
  }
  const parent = profilesById.get(parentId);
  if (!parent) {
    throw new Error(`Unknown parent Agent Profile ${parentId} for ${profileId}`);
  }
  return [...resolveBuiltInProfileAncestry(parent.id, [...active, profileId]), profile];
}

function resolvePortableCommon(ancestry: readonly BuiltInAgentProfile[]): AgentProfileCommon {
  const resolved: AgentProfileCommon = {};
  for (const profile of ancestry) {
    Object.assign(resolved, profile.resource.spec.common);
  }
  return resolved;
}

function resolveBuiltInProfile(profileId: AgentProfileId): ResolvedBuiltInAgentProfile {
  const cached = resolvedProfilesById.get(profileId);
  if (cached) {
    return cached;
  }
  const ancestry = resolveBuiltInProfileAncestry(profileId);
  const openClawExtension = resolveOpenClawAgentProfileExtension(ancestry);
  const resolved: ResolvedBuiltInAgentProfile = {
    id: profileId,
    ancestry: ancestry.map((profile) => profile.id),
    spec: {
      common: resolvePortableCommon(ancestry),
      ...(openClawExtension ? { "openclaw.ai": openClawExtension } : {}),
    },
  };
  resolvedProfilesById.set(profileId, resolved);
  return resolved;
}

function resolveProfileAgentId(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (params.config) {
    return resolveSessionAgentIds({
      config: params.config,
      agentId: explicitAgentId,
      sessionKey: params.sessionKey,
    }).sessionAgentId;
  }
  const parsedSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  return (
    explicitAgentId ?? (parsedSessionAgentId ? normalizeAgentId(parsedSessionAgentId) : undefined)
  );
}

function resolveConfiguredSelector(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): {
  selector?: AgentProfileSelector;
  source?: AgentProfileSelectionSource;
} {
  const agentId = resolveProfileAgentId(params);
  const agentSelector =
    params.config && agentId
      ? resolveAgentConfig(params.config, agentId)?.agentProfileId
      : undefined;
  if (agentSelector) {
    return { selector: agentSelector, source: "agent-explicit" };
  }
  const defaultsSelector = params.config?.agents?.defaults?.agentProfileId;
  return { selector: defaultsSelector, source: defaultsSelector ? "defaults-explicit" : undefined };
}

export function resolveAgentProfile(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): ResolvedAgentProfile {
  const configured = resolveConfiguredSelector(params);
  if (!configured.selector) {
    return { profile: resolveBuiltInProfile("openclaw/base"), selectionSource: "fallback" };
  }
  return {
    profile: resolveBuiltInProfile(configured.selector),
    selectionSource: configured.source ?? "defaults-explicit",
  };
}
