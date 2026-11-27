/** OpenClaw behavior applied from resolved Agent Profiles. */
import { messageToolOwnsVisibleReply } from "../auto-reply/source-reply-delivery-mode.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentProfile, type ResolvedAgentProfile } from "./agent-profiles/resolve.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { expandToolGroups, normalizeToolPolicyName } from "./tool-policy.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

export { resolveAgentProfile };
export type { ResolvedAgentProfile };

const COMPACT_TOOL_DENY_NAMES = new Set([
  "browser",
  "image_generate",
  "message",
  "music_generate",
  "pdf",
  "tts",
  "video_generate",
]);
// openclaw/small is the exact local-model Lean surface, which also removes automations.
const LEAN_TOOL_DENY_NAMES = new Set([...COMPACT_TOOL_DENY_NAMES, AUTOMATIONS_TOOL_NAME]);
const TOOL_PROFILE_DENY_NAMES = {
  lean: LEAN_TOOL_DENY_NAMES,
  compact: COMPACT_TOOL_DENY_NAMES,
} as const;
const COMPACT_TOOL_SEARCH_DEFAULTS = {
  enabled: true,
  mode: "tools",
  searchDefaultLimit: 5,
  maxSearchLimit: 10,
} as const;

/** The reduced tool profile the resolved profile selects, if any. */
function resolveToolProfile(resolved: ResolvedAgentProfile) {
  return resolved.profile.spec["openclaw.ai"]?.toolProfile;
}

/** True when the resolved profile selects a reduced tool surface (lean or compact). */
export function hasReducedToolProfile(resolved: ResolvedAgentProfile): boolean {
  return resolveToolProfile(resolved) !== undefined;
}

function resolvePreservedToolNames(names?: Iterable<string>) {
  if (!names) {
    return [];
  }
  return compileGlobPatterns({
    raw: expandToolGroups([...names]).filter((name) => normalizeToolPolicyName(name) !== "*"),
    normalize: normalizeToolPolicyName,
  });
}

export function resolveAgentProfilePreserveToolNames(params?: {
  toolNames?: Iterable<string>;
  forceMessageTool?: boolean;
  sourceReplyDeliveryMode?: string;
}): string[] {
  const names = [...(params?.toolNames ?? [])];
  if (params && messageToolOwnsVisibleReply(params)) {
    names.push("message");
  }
  return [...new Set(names)];
}

export function filterToolsByAgentProfile<T extends Pick<AnyAgentTool, "name">>(params: {
  tools: T[];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  resolvedProfile?: ResolvedAgentProfile;
  preserveToolNames?: Iterable<string>;
}): T[] {
  const resolved = params.resolvedProfile ?? resolveAgentProfile(params);
  const toolProfile = resolveToolProfile(resolved);
  if (!toolProfile) {
    return params.tools;
  }
  const denyNames = TOOL_PROFILE_DENY_NAMES[toolProfile];
  const preservedToolNames = resolvePreservedToolNames(params.preserveToolNames);
  return params.tools.filter((tool) => {
    const normalizedName = normalizeToolPolicyName(tool.name);
    return (
      matchesAnyGlobPattern(normalizedName, preservedToolNames) || !denyNames.has(normalizedName)
    );
  });
}

export function applyAgentProfileToolSearchDefaults(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  resolvedProfile?: ResolvedAgentProfile;
}): OpenClawConfig | undefined {
  if (!params.config) {
    return params.config;
  }
  const resolved = params.resolvedProfile ?? resolveAgentProfile(params);
  if (!hasReducedToolProfile(resolved)) {
    return params.config;
  }
  if (params.config.tools?.toolSearch !== undefined) {
    return params.config;
  }
  return {
    ...params.config,
    tools: {
      ...params.config.tools,
      toolSearch: COMPACT_TOOL_SEARCH_DEFAULTS,
    },
  };
}
