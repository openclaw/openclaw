import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/compaction-profiles");

export type CompactionProfileId = "default" | "coding" | "conversation" | "research";

export type CompactionProfile = {
  id: CompactionProfileId;
  description: string;
  instructions: string;
};

const PROFILES: Record<CompactionProfileId, CompactionProfile> = {
  default: {
    id: "default",
    description: "General-purpose compaction preserving recent context and decisions",
    instructions: `Summarize the conversation while preserving:
- The most recent 3 exchanges in detail
- Key decisions made and their rationale
- Action items and their current status
- Important context for ongoing tasks
- User preferences expressed during the conversation
Omit routine greetings, acknowledgments, and repeated information.`,
  },
  coding: {
    id: "coding",
    description: "Optimized for coding sessions preserving code context",
    instructions: `Summarize the coding session while preserving:
- All file paths mentioned and their purposes
- Code changes made (what was modified, added, or removed)
- Error messages and their resolutions
- Build/test results and their outcomes
- Architecture decisions and constraints
- The current state of the task (what's done, what's pending)
- Key technical details (library versions, API endpoints, configuration)
Omit verbose tool output that has been processed, routine acknowledgments.`,
  },
  conversation: {
    id: "conversation",
    description: "Optimized for discussions preserving decisions and action items",
    instructions: `Summarize the discussion while preserving:
- All decisions made and who made them
- Action items with assignees and deadlines
- Key arguments and counterarguments for important decisions
- Agreed-upon plans and timelines
- Unresolved questions or open issues
- Participant preferences and constraints
Omit small talk, repeated summaries, and routine pleasantries.`,
  },
  research: {
    id: "research",
    description: "Optimized for research preserving data and sources",
    instructions: `Summarize the research session while preserving:
- All data points, statistics, and findings
- Source URLs and references
- Comparisons and analysis results
- Hypotheses tested and their outcomes
- Key quotes or excerpts from sources
- Methodology and search strategies used
- Open questions and next steps for investigation
Omit navigation steps, failed searches, and redundant lookups.`,
  },
};

export function getCompactionProfile(id: CompactionProfileId): CompactionProfile {
  return PROFILES[id] ?? PROFILES.default;
}

export function listCompactionProfiles(): CompactionProfile[] {
  return Object.values(PROFILES);
}

export function isValidProfileId(id: string): id is CompactionProfileId {
  return id in PROFILES;
}

export type ProactiveCompactionConfig = {
  /** Trigger proactive compaction at this fraction of context window usage. */
  proactiveThreshold: number;
  /** Active compaction profile. */
  profile: CompactionProfileId;
};

const DEFAULT_PROACTIVE_CONFIG: ProactiveCompactionConfig = {
  proactiveThreshold: 0.65,
  profile: "default",
};

export function resolveProactiveCompactionConfig(cfg?: OpenClawConfig): ProactiveCompactionConfig {
  const raw = cfg?.agents?.defaults?.compaction as Record<string, unknown> | undefined;
  if (!raw) {
    return DEFAULT_PROACTIVE_CONFIG;
  }

  const threshold =
    typeof raw.proactiveThreshold === "number"
      ? Math.max(0.1, Math.min(0.95, raw.proactiveThreshold))
      : DEFAULT_PROACTIVE_CONFIG.proactiveThreshold;
  const profileRaw = typeof raw.profile === "string" ? raw.profile : "default";
  const profile = isValidProfileId(profileRaw) ? profileRaw : "default";

  return { proactiveThreshold: threshold, profile };
}

/**
 * Check if proactive compaction should trigger based on current context usage.
 */
export function shouldTriggerProactiveCompaction(params: {
  totalTokens: number;
  contextWindowTokens: number;
  config: ProactiveCompactionConfig;
}): boolean {
  const { totalTokens, contextWindowTokens, config } = params;

  if (contextWindowTokens <= 0 || totalTokens <= 0) {
    return false;
  }

  const usage = totalTokens / contextWindowTokens;
  const shouldTrigger = usage >= config.proactiveThreshold;

  if (shouldTrigger) {
    log.info(
      `proactive compaction triggered: usage=${(usage * 100).toFixed(1)}% ` +
        `threshold=${(config.proactiveThreshold * 100).toFixed(1)}% ` +
        `profile=${config.profile}`,
    );
  }

  return shouldTrigger;
}

/**
 * Build compaction instructions incorporating the active profile.
 */
export function buildProfileCompactionInstructions(
  profile: CompactionProfileId,
  customInstructions?: string,
): string {
  const profileDef = getCompactionProfile(profile);
  const parts = [profileDef.instructions];

  if (customInstructions?.trim()) {
    parts.push(`\nAdditional instructions:\n${customInstructions.trim()}`);
  }

  return parts.join("\n");
}

/**
 * Parse a /compact command to extract profile and custom instructions.
 * Formats:
 *   /compact           → default profile
 *   /compact coding    → coding profile
 *   /compact: custom   → default profile with custom instructions
 *   /compact coding: custom → coding profile with custom instructions
 */
export function parseCompactCommand(input: string): {
  profile: CompactionProfileId;
  instructions?: string;
} {
  const trimmed = input.trim();

  // Check for profile followed by colon
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex >= 0) {
    const beforeColon = trimmed.slice(0, colonIndex).trim();
    const afterColon = trimmed.slice(colonIndex + 1).trim();

    if (isValidProfileId(beforeColon)) {
      return {
        profile: beforeColon,
        instructions: afterColon || undefined,
      };
    }

    return {
      profile: "default",
      instructions: afterColon || undefined,
    };
  }

  // Check for profile name only
  if (isValidProfileId(trimmed)) {
    return { profile: trimmed };
  }

  // If non-empty but not a profile, treat as custom instructions
  if (trimmed) {
    return { profile: "default", instructions: trimmed };
  }

  return { profile: "default" };
}
