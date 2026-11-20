/** OpenClaw behavior applied from resolved Agent Profiles. */
import { messageToolOwnsVisibleReply } from "../auto-reply/source-reply-delivery-mode.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentProfile, type ResolvedAgentProfile } from "./agent-profiles/resolve.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { expandToolGroups, normalizeToolPolicyName } from "./tool-policy.js";

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
const COMPACT_TOOL_SEARCH_DEFAULTS = {
  enabled: true,
  mode: "tools",
  searchDefaultLimit: 5,
  maxSearchLimit: 10,
} as const;

/** True when the resolved profile selects the compact tool surface. */
export function hasCompactToolProfile(resolved: ResolvedAgentProfile): boolean {
  return resolved.profile.spec["openclaw.ai"]?.toolProfile === "compact";
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
  if (!hasCompactToolProfile(resolved)) {
    return params.tools;
  }
  const preservedToolNames = resolvePreservedToolNames(params.preserveToolNames);
  return params.tools.filter((tool) => {
    const normalizedName = normalizeToolPolicyName(tool.name);
    return (
      matchesAnyGlobPattern(normalizedName, preservedToolNames) ||
      !COMPACT_TOOL_DENY_NAMES.has(normalizedName)
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
  if (!hasCompactToolProfile(resolved)) {
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
