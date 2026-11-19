/**
 * Local-model lean tool filtering.
 * Removes high-latency or channel-dependent tools for local models while
 * preserving explicitly required delivery tools.
 */
import { messageToolOwnsVisibleReply } from "../auto-reply/source-reply-delivery-mode.js";
import { resolveAgentProfile, type AgentProfileScope } from "./agent-profiles.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { expandToolGroups, normalizeToolPolicyName } from "./tool-policy.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

const LOCAL_MODEL_LEAN_DENY_TOOL_NAMES = new Set([
  "browser",
  AUTOMATIONS_TOOL_NAME,
  "image_generate",
  "message",
  "music_generate",
  "pdf",
  "tts",
  "video_generate",
]);

function resolvePreservedLocalModelLeanToolNames(names?: Iterable<string>) {
  if (!names) {
    return [];
  }
  return compileGlobPatterns({
    raw: expandToolGroups([...names]).filter((name) => normalizeToolPolicyName(name) !== "*"),
    normalize: normalizeToolPolicyName,
  });
}

/** Resolves tool names that must survive local-model lean filtering. */
export function resolveLocalModelLeanPreserveToolNames(params?: {
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

/** Returns true when the selected Agent Profile uses the lean OpenClaw tool profile. */
export function isLocalModelLeanEnabled(params: AgentProfileScope): boolean {
  return resolveAgentProfile(params).profile.spec["openclaw.ai"]?.toolProfile === "lean";
}

/** Filters tools for local-model lean mode while preserving required delivery tools. */
export function filterLocalModelLeanTools(
  params: AgentProfileScope & {
    tools: AnyAgentTool[];
    preserveToolNames?: Iterable<string>;
  },
): AnyAgentTool[] {
  if (!isLocalModelLeanEnabled(params)) {
    return params.tools;
  }
  const preservedToolNames = resolvePreservedLocalModelLeanToolNames(params.preserveToolNames);
  return params.tools.filter((tool) => {
    const normalizedName = normalizeToolPolicyName(tool.name);
    return (
      matchesAnyGlobPattern(normalizedName, preservedToolNames) ||
      !LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(normalizedName)
    );
  });
}
