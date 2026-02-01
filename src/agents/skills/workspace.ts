import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  ParsedSkillFrontmatter,
  PermissionRiskLevel,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillEntryWithPermissions,
  SkillSnapshot,
} from "./types.js";
import { validatePermissionManifest } from "./permissions.js";
import type { SkillsSecurityConfig } from "../../config/types.skills.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { shouldIncludeSkill } from "./config.js";
import {
  parseFrontmatter,
  parsePermissionManifest,
  resolveOpenClawMetadata,
  resolveSkillInvocationPolicy,
} from "./frontmatter.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import { serializeByKey } from "./serialize.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = new Set<string>();

function debugSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.has(messageKey)) {
    return;
  }
  skillCommandDebugOnce.add(messageKey);
  skillsLogger.debug(message, meta);
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  eligibility?: SkillEligibilityContext,
): SkillEntry[] {
  let filtered = entries.filter((entry) => shouldIncludeSkill({ entry, config, eligibility }));
  // If skillFilter is provided, only include skills in the filter list.
  if (skillFilter !== undefined) {
    const normalized = skillFilter.map((entry) => String(entry).trim()).filter(Boolean);
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    console.log(`[skills] Applying skill filter: ${label}`);
    filtered =
      normalized.length > 0
        ? filtered.filter((entry) => normalized.includes(entry.skill.name))
        : [];
    console.log(`[skills] After filter: ${filtered.map((entry) => entry.skill.name).join(", ")}`);
  }
  return filtered;
}

// Track whether we've shown the deprecation notice this session
let shownDeprecationNotice = false;

/**
 * Risk level ordering for comparison.
 */
const RISK_LEVEL_ORDER: PermissionRiskLevel[] = ["minimal", "low", "moderate", "high", "critical"];

/**
 * Parse permissions and validate for a skill entry.
 * Returns an extended entry with permission information.
 */
function enrichWithPermissions(entry: SkillEntry): SkillEntryWithPermissions {
  const permissions = parsePermissionManifest(entry.frontmatter);
  const permissionValidation = validatePermissionManifest(permissions, entry.skill.name);

  return {
    ...entry,
    permissions,
    permissionValidation,
  };
}

/**
 * Apply security policy filtering to skill entries.
 * This filters out skills that don't meet the security requirements.
 *
 * IMPORTANT: This is an advisory system. Skills declare their intended permissions,
 * but this cannot enforce actual runtime behavior. The goal is transparency and
 * informed consent, not mechanical sandboxing.
 */
function filterBySecurityPolicy(
  entries: SkillEntryWithPermissions[],
  securityConfig?: SkillsSecurityConfig,
): SkillEntryWithPermissions[] {
  const requireManifest = securityConfig?.requireManifest ?? "warn";
  const maxAutoLoadRisk = securityConfig?.maxAutoLoadRisk ?? "moderate";
  const maxRiskIndex = RISK_LEVEL_ORDER.indexOf(maxAutoLoadRisk);

  // Track skills that need attention for logging
  const noManifestSkills: string[] = [];
  const highRiskSkills: Array<{ name: string; level: PermissionRiskLevel }> = [];
  const deniedSkills: Array<{ name: string; reason: string }> = [];

  const filtered = entries.filter((entry) => {
    const skillName = entry.skill.name;
    const validation = entry.permissionValidation;

    // Handle skills without manifests
    if (!entry.permissions) {
      noManifestSkills.push(skillName);

      if (requireManifest === "deny") {
        deniedSkills.push({ name: skillName, reason: "no permission manifest (policy: deny)" });
        return false;
      }
      // "allow", "warn", "prompt" all allow loading (prompt handling is CLI-specific)
      // The warning is logged below
    }

    // Check risk level against max auto-load threshold
    if (validation) {
      const skillRiskIndex = RISK_LEVEL_ORDER.indexOf(validation.risk_level);

      if (skillRiskIndex > maxRiskIndex) {
        // Log high-risk skills but only deny if explicitly configured
        highRiskSkills.push({ name: skillName, level: validation.risk_level });

        // For now, we warn but don't block based on risk level alone
        // Future: "prompt" mode could require approval for high-risk skills
        skillsLogger.warn(`Skill "${skillName}" has ${validation.risk_level} risk level`, {
          skillName,
          riskLevel: validation.risk_level,
          maxAutoLoad: maxAutoLoadRisk,
          // Don't log detailed risk factors - they may contain sensitive pattern info
          riskFactorCount: validation.risk_factors.length,
        });
      }
    }

    return true;
  });

  // Log summary for skills without manifests
  if (noManifestSkills.length > 0) {
    if (requireManifest === "warn") {
      skillsLogger.warn(
        `${noManifestSkills.length} skill(s) have no permission manifest: ${noManifestSkills.join(", ")}`,
        { skills: noManifestSkills },
      );

      // Show deprecation notice once per session
      if (!shownDeprecationNotice) {
        shownDeprecationNotice = true;
          "Note: A future version of OpenClaw will require explicit approval for skills without " +
            "permission manifests. Run `openclaw skills audit` to review your skills.",
        );
      }
    }
  }

  // Log denied skills
  for (const denied of deniedSkills) {
    skillsLogger.info(`Skipped skill "${denied.name}": ${denied.reason}`);
  }

  return filtered;
}

const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
// Discord command descriptions must be ≤100 characters
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

function sanitizeSkillCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);
  return trimmed || SKILL_COMMAND_FALLBACK;
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  const normalizedBase = base.toLowerCase();
  if (!used.has(normalizedBase)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    const candidateKey = candidate.toLowerCase();
    if (!used.has(candidateKey)) {
      return candidate;
    }
  }
  const fallback = `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
  return fallback;
}

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntry[] {
  const loadSkills = (params: { dir: string; source: string }): Skill[] => {
    const loaded = loadSkillsFromDir(params);
    if (Array.isArray(loaded)) {
      return loaded;
    }
    if (
      loaded &&
      typeof loaded === "object" &&
      "skills" in loaded &&
      Array.isArray((loaded as { skills?: unknown }).skills)
    ) {
      return (loaded as { skills: Skill[] }).skills;
    }
    return [];
  };

  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const workspaceSkillsDir = path.join(workspaceDir, "skills");
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  const extraDirsRaw = opts?.config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean);
  const pluginSkillDirs = resolvePluginSkillDirs({
    workspaceDir,
    config: opts?.config,
  });
  const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];

  const bundledSkills = bundledSkillsDir
    ? loadSkills({
        dir: bundledSkillsDir,
        source: "openclaw-bundled",
      })
    : [];
  const extraSkills = mergedExtraDirs.flatMap((dir) => {
    const resolved = resolveUserPath(dir);
    return loadSkills({
      dir: resolved,
      source: "openclaw-extra",
    });
  });
  const managedSkills = loadSkills({
    dir: managedSkillsDir,
    source: "openclaw-managed",
  });
  const workspaceSkills = loadSkills({
    dir: workspaceSkillsDir,
    source: "openclaw-workspace",
  });

  const merged = new Map<string, Skill>();
  // Precedence: extra < bundled < managed < workspace
  for (const skill of extraSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of bundledSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of managedSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of workspaceSkills) {
    merged.set(skill.name, skill);
  }

  const skillEntries: SkillEntry[] = Array.from(merged.values()).map((skill) => {
    let frontmatter: ParsedSkillFrontmatter = {};
    try {
      const raw = fs.readFileSync(skill.filePath, "utf-8");
      frontmatter = parseFrontmatter(raw);
    } catch {
      // ignore malformed skills
    }
    return {
      skill,
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
  });
  return skillEntries;
}

/**
 * Load skill entries with permission validation and security policy filtering.
 *
 * This is the preferred entry point for loading skills as it:
 * 1. Loads all skill entries from configured directories
 * 2. Parses and validates permission manifests
 * 3. Applies security policy filtering based on config
 *
 * Note: Permission manifests are advisory declarations. This system provides
 * transparency about what skills claim to need, but cannot enforce runtime behavior.
 */
function loadSkillEntriesWithSecurity(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntryWithPermissions[] {
  // Load base entries
  const baseEntries = loadSkillEntries(workspaceDir, opts);

  // Enrich with permission information
  const enrichedEntries = baseEntries.map(enrichWithPermissions);

  // Apply security policy filtering
  const securityConfig = opts?.config?.skills?.security;
  const filtered = filterBySecurityPolicy(enrichedEntries, securityConfig);

  return filtered;
}

export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    /** If provided, only include skills with these names */
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    snapshotVersion?: number;
  },
): SkillSnapshot {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
  );
  const promptEntries = eligible.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  );
  const resolvedSkills = promptEntries.map((entry) => entry.skill);
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const prompt = [remoteNote, formatSkillsForPrompt(resolvedSkills)].filter(Boolean).join("\n");
  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
    })),
    resolvedSkills,
    version: opts?.snapshotVersion,
  };
}

export function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    /** If provided, only include skills with these names */
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
  },
): string {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
  );
  const promptEntries = eligible.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  );
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  return [remoteNote, formatSkillsForPrompt(promptEntries.map((entry) => entry.skill))]
    .filter(Boolean)
    .join("\n");
}

export function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
}): string {
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (snapshotPrompt) {
    return snapshotPrompt;
  }
  if (params.entries && params.entries.length > 0) {
    const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
    });
    return prompt.trim() ? prompt : "";
  }
  return "";
}

export function loadWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    /** Skip security policy filtering (returns raw entries). Default: false */
    skipSecurityFilter?: boolean;
  },
): SkillEntryWithPermissions[] {
  if (opts?.skipSecurityFilter) {
    // Return entries with permissions but without security filtering
    const baseEntries = loadSkillEntries(workspaceDir, opts);
    return baseEntries.map(enrichWithPermissions);
  }
  return loadSkillEntriesWithSecurity(workspaceDir, opts);
}

export async function syncSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
}) {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return;
  }

  await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");

    const entries = loadSkillEntries(sourceDir, {
      config: params.config,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
    });

    await fsp.rm(targetSkillsDir, { recursive: true, force: true });
    await fsp.mkdir(targetSkillsDir, { recursive: true });

    for (const entry of entries) {
      const dest = path.join(targetSkillsDir, entry.skill.name);
      try {
        await fsp.cp(entry.skill.baseDir, dest, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        console.warn(`[skills] Failed to copy ${entry.skill.name} to sandbox: ${message}`);
      }
    }
  });
}

export function filterWorkspaceSkillEntries(
  entries: SkillEntry[] | SkillEntryWithPermissions[],
  config?: OpenClawConfig,
): SkillEntryWithPermissions[] {
  // Ensure entries have permission info
  const enriched = entries.map((entry) => {
    if ("permissionValidation" in entry) {
      return entry as SkillEntryWithPermissions;
    }
    return enrichWithPermissions(entry);
  });

  // Apply existing filters
  const filtered = filterSkillEntries(enriched, config);

  // Apply security policy filtering
  const securityConfig = config?.skills?.security;
  return filterBySecurityPolicy(
    filtered.map((e) =>
      "permissionValidation" in e ? (e as SkillEntryWithPermissions) : enrichWithPermissions(e),
    ),
    securityConfig,
  );
}

export function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    reservedNames?: Set<string>;
  },
): SkillCommandSpec[] {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
  );
  const userInvocable = eligible.filter((entry) => entry.invocation?.userInvocable !== false);
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }

  const specs: SkillCommandSpec[] = [];
  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    const base = sanitizeSkillCommandName(rawName);
    if (base !== rawName) {
      debugSkillCommandOnce(
        `sanitize:${rawName}:${base}`,
        `Sanitized skill command name "${rawName}" to "/${base}".`,
        { rawName, sanitized: `/${base}` },
      );
    }
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      debugSkillCommandOnce(
        `dedupe:${rawName}:${unique}`,
        `De-duplicated skill command name for "${rawName}" to "/${unique}".`,
        { rawName, deduped: `/${unique}` },
      );
    }
    used.add(unique.toLowerCase());
    const rawDescription = entry.skill.description?.trim() || rawName;
    const description =
      rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
        ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…"
        : rawDescription;
    const dispatch = (() => {
      const kindRaw = (
        entry.frontmatter?.["command-dispatch"] ??
        entry.frontmatter?.["command_dispatch"] ??
        ""
      )
        .trim()
        .toLowerCase();
      if (!kindRaw) {
        return undefined;
      }
      if (kindRaw !== "tool") {
        return undefined;
      }

      const toolName = (
        entry.frontmatter?.["command-tool"] ??
        entry.frontmatter?.["command_tool"] ??
        ""
      ).trim();
      if (!toolName) {
        debugSkillCommandOnce(
          `dispatch:missingTool:${rawName}`,
          `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`,
          { skillName: rawName, command: unique },
        );
        return undefined;
      }

      const argModeRaw = (
        entry.frontmatter?.["command-arg-mode"] ??
        entry.frontmatter?.["command_arg_mode"] ??
        ""
      )
        .trim()
        .toLowerCase();
      const argMode = !argModeRaw || argModeRaw === "raw" ? "raw" : null;
      if (!argMode) {
        debugSkillCommandOnce(
          `dispatch:badArgMode:${rawName}:${argModeRaw}`,
          `Skill command "/${unique}" requested tool dispatch but has unknown command-arg-mode. Falling back to raw.`,
          { skillName: rawName, command: unique, argMode: argModeRaw },
        );
      }

      return { kind: "tool", toolName, argMode: "raw" } as const;
    })();

    specs.push({
      name: unique,
      skillName: rawName,
      description,
      ...(dispatch ? { dispatch } : {}),
    });
  }
  return specs;
}
