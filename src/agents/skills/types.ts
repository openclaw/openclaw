import type { Skill } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Skill capabilities — what system access a skill needs.
// Maps to existing TOOL_GROUPS in tool-policy.ts.
//
// CLAWHUB ALIGNMENT: This exact enum is shared between OpenClaw (load-time
// validation) and ClawHub (publish-time validation). If you add a value here,
// add it to clawhub/convex/lib/skillCapabilities.ts too.
//
// Frontmatter usage (under metadata.openclaw):
//   openclaw:
//     capabilities: [shell, filesystem]
//
// No capabilities declared = read-only, model-only skill.
// ---------------------------------------------------------------------------
export const SKILL_CAPABILITIES = [
  "shell", // exec, process — run shell commands
  "filesystem", // write, edit, apply_patch — file mutations (read is always allowed)
  "network", // web_search, web_fetch — outbound HTTP
  "browser", // browser — browser automation
  "sessions", // sessions_spawn, sessions_send — cross-session orchestration
  "messaging", // message — send messages to configured channels
  "scheduling", // cron — schedule recurring jobs
] as const;

export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];

export type SkillInstallSpec = {
  id?: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
};

export type OpenClawSkillMetadata = {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  install?: SkillInstallSpec[];
  capabilities?: SkillCapability[];
};

export type SkillInvocationPolicy = {
  userInvocable: boolean;
  disableModelInvocation: boolean;
};

export type SkillCommandDispatchSpec = {
  kind: "tool";
  /** Name of the tool to invoke (AnyAgentTool.name). */
  toolName: string;
  /**
   * How to forward user-provided args to the tool.
   * - raw: forward the raw args string (no core parsing).
   */
  argMode?: "raw";
};

export type SkillCommandSpec = {
  name: string;
  skillName: string;
  description: string;
  /** Optional deterministic dispatch behavior for this command. */
  dispatch?: SkillCommandDispatchSpec;
};

export type SkillsInstallPreferences = {
  preferBrew: boolean;
  nodeManager: "npm" | "pnpm" | "yarn" | "bun";
};

export type ParsedSkillFrontmatter = Record<string, string>;

export type SkillScanResult = {
  severity: "clean" | "info" | "warn" | "critical";
  findings: Array<{ ruleId: string; severity: string; message: string; line: number }>;
};

export type SkillEntry = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  metadata?: OpenClawSkillMetadata;
  invocation?: SkillInvocationPolicy;
  scanResult?: SkillScanResult;
};

export type SkillEligibilityContext = {
  remote?: {
    platforms: string[];
    hasBin: (bin: string) => boolean;
    hasAnyBin: (bins: string[]) => boolean;
    note?: string;
  };
};

export type SkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  resolvedSkills?: Skill[];
  version?: number;
};
