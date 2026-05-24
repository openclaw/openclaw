import type { Skill } from "./skill-contract.js";

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

export type SkillTelemetrySource = "bundled" | "unknown" | "workspace";

export type SkillCommandSpec = {
  name: string;
  skillName: string;
  description: string;
  /** Bounded source label used for diagnostics. */
  skillSource?: SkillTelemetrySource;
  /** Localized descriptions for native command surfaces that support them. */
  descriptionLocalizations?: Record<string, string>;
  /** Optional deterministic dispatch behavior for this command. */
  dispatch?: SkillCommandDispatchSpec;
  /** Native prompt template used by Claude-bundle command markdown files. */
  promptTemplate?: string;
  /** Source markdown path for bundle-backed commands. */
  sourceFilePath?: string;
};

export type SkillsInstallPreferences = {
  preferBrew: boolean;
  nodeManager: "npm" | "pnpm" | "yarn" | "bun";
};

export type ParsedSkillFrontmatter = Record<string, string>;

export type SkillExposure = {
  includeInRuntimeRegistry: boolean;
  includeInAvailableSkillsPrompt: boolean;
  userInvocable: boolean;
};

export type SkillEntry = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  metadata?: OpenClawSkillMetadata;
  invocation?: SkillInvocationPolicy;
  exposure?: SkillExposure;
  syncSourceDir?: string;
  syncDirName?: string;
};

export type SkillEligibilityContext = {
  remote?: {
    platforms: string[];
    hasBin: (bin: string) => boolean;
    hasAnyBin: (bins: string[]) => boolean;
    note?: string;
  };
};

/**
 * Bumped whenever the `SkillSnapshot` field set changes in a way that
 * persisted snapshots from older builds cannot satisfy. `agent-command.ts`
 * compares this against the stored `schemaVersion` and force-rebuilds when
 * the stored value is missing or lower. Keep in sync with
 * `buildWorkspaceSkillSnapshot`.
 *
 * - v1 (implicit, pre-2026-05-25): `prompt`, `skills`, `skillFilter`,
 *   `resolvedSkills`, `version`.
 * - v2 (2026-05-25): adds `trustedDeveloperPrompt` and
 *   `untrustedReferencePrompt` for the Codex skills-lane split.
 * - v3 (2026-05-25): adds `remoteNote` so Codex sees remote-host
 *   execution guidance (`exec host=node` etc.) after the lane split
 *   removed the legacy `prompt` consumer from the Codex turn.
 */
export const SKILL_SNAPSHOT_SCHEMA_VERSION = 3;

export type SkillSnapshot = {
  prompt: string;
  /**
   * Trusted skills prompt fragment safe to elevate into developer-instruction
   * authority (e.g. Codex `collaborationMode.settings.developer_instructions`).
   * Built from only `openclaw-bundled` skills; workspace, project (.agents),
   * personal (~/.agents/skills), `openclaw-managed`, `openclaw-extra`, and
   * plugin-generated skill metadata is excluded because their SKILL.md
   * frontmatter is user/install-controlled and must not gain developer
   * authority. Undefined when no trusted skills are eligible.
   */
  trustedDeveloperPrompt?: string;
  /**
   * Untrusted skills prompt fragment for the user/reference lane (e.g. Codex
   * per-turn user input under the OpenClaw workspace context wrapper). Built
   * from every non-bundled source (workspace, project `.agents`, personal
   * `~/.agents/skills`, `openclaw-managed`, `openclaw-extra`, and
   * plugin-generated) so native Codex turns keep seeing user-installed
   * skills without granting them developer authority. Undefined when no
   * non-bundled skills are eligible.
   */
  untrustedReferencePrompt?: string;
  /**
   * Remote-host execution guidance for the active runtime (e.g.
   * `exec host=node`). Computed at snapshot build time from
   * `opts.eligibility.remote.note`. The legacy `prompt` field already
   * prepends this note for non-Codex surfaces; persisting it separately
   * lets the Codex call site render it into a non-authoritative reference
   * lane after the lane split removed the legacy `prompt` consumer from
   * the Codex turn. Undefined when the runtime is local-only.
   */
  remoteNote?: string;
  /**
   * Schema marker for this `SkillSnapshot` shape. Persisted snapshots written
   * by older builds will have `schemaVersion === undefined`; the
   * `agent-command.ts` reuse path treats that as a forced-refresh signal so
   * the new lane-split fields above are populated before the snapshot is
   * read. See `SKILL_SNAPSHOT_SCHEMA_VERSION`.
   */
  schemaVersion?: number;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  resolvedSkills?: Skill[];
  version?: number;
};
