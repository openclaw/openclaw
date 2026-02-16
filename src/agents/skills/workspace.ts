import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillSnapshot,
} from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolveSandboxPath } from "../sandbox-paths.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { shouldIncludeSkill } from "./config.js";
import { normalizeSkillFilter } from "./filter.js";
import {
  parseFrontmatter,
  resolveOpenClawMetadata,
  resolveSkillInvocationPolicy,
} from "./frontmatter.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import { SkillSemanticIndex, resolveEmbedFn, type SemanticSkillConfig } from "./semantic-index.js";
import { serializeByKey } from "./serialize.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = new Set<string>();

// Cached semantic index for dynamic skill loading
let cachedSemanticIndex: SkillSemanticIndex | null = null;
let cachedIndexHash: string | null = null;

/**
 * Get or create a semantic skill index for the workspace.
 * Uses caching to avoid rebuilding the index on every request.
 */
async function getOrCreateSemanticIndex(
  entries: SkillEntry[],
  config?: OpenClawConfig,
): Promise<SkillSemanticIndex | null> {
  const dynamicConfig = config?.skills?.dynamicLoading;
  if (!dynamicConfig?.enabled) {
    return null;
  }

  // Create a hash of skill names and mtimes to detect changes (including content)
  const entriesHash = entries
    .map((e) => {
      const stat = fs.statSync(e.skill.filePath);
      return `${e.skill.name}:${stat.mtimeMs}`;
    })
    .sort()
    .join(",");

  if (cachedSemanticIndex && cachedIndexHash === entriesHash) {
    skillsLogger.debug("Using cached semantic skill index");
    return cachedSemanticIndex;
  }

  // Resolve embedding function from config
  const provider = dynamicConfig.embeddingProvider ?? "openai";
  const apiKey = resolveEmbeddingApiKey(provider, config);

  if (!apiKey) {
    skillsLogger.warn(
      `No API key found for embedding provider "${provider}". ` +
        "Falling back to full skill loading.",
    );
    return null;
  }

  const embedFn = resolveEmbedFn(provider, apiKey, dynamicConfig.embeddingModel);

  // Build new index
  const semanticConfig: Partial<SemanticSkillConfig> = {
    enabled: true,
    topK: dynamicConfig.topK ?? 5,
    minScore: dynamicConfig.minScore ?? 0.3,
    embeddingModel: dynamicConfig.embeddingModel,
  };

  const index = new SkillSemanticIndex(semanticConfig);

  try {
    await index.buildIndex(entries, embedFn);
    cachedSemanticIndex = index;
    cachedIndexHash = entriesHash;
    skillsLogger.info(
      `Built semantic index for ${entries.length} skills ` +
        `(provider: ${provider}, topK: ${semanticConfig.topK})`,
    );
    return index;
  } catch (error) {
    skillsLogger.error(
      `Failed to build semantic skill index: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Resolve API key for embedding provider from config or environment.
 */
function resolveEmbeddingApiKey(provider: string, config?: OpenClawConfig): string | undefined {
  // First check environment variables
  const envKeys: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    voyage: "VOYAGE_API_KEY",
    anthropic: "VOYAGE_API_KEY", // Anthropic uses Voyage for embeddings
  };

  const envKey = envKeys[provider.toLowerCase()];
  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }

  // Fallback to any configured OpenAI key in the config
  // This is a simplification - real implementation might need
  // to look up provider-specific keys in config
  return process.env.OPENAI_API_KEY;
}

/**
 * Format a lightweight skill directory for the prompt.
 * Only includes skill names and one-line descriptions.
 */
function formatSkillDirectory(directory: Array<{ name: string; description: string }>): string {
  if (directory.length === 0) {
    return "";
  }

  const lines = directory.map((s) => `- ${s.name}: ${s.description.slice(0, 100)}`);

  return [
    "## Available Skills (lightweight directory)",
    "The following skills are installed but not fully loaded.",
    "Request a skill by name if needed for the current task.",
    "",
    ...lines,
  ].join("\n");
}

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
    const normalized = normalizeSkillFilter(skillFilter) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    filtered =
      normalized.length > 0
        ? filtered.filter((entry) => normalized.includes(entry.skill.name))
        : [];
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
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
  const workspaceSkillsDir = path.resolve(workspaceDir, "skills");
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
  const personalAgentsSkillsDir = path.resolve(os.homedir(), ".agents", "skills");
  const personalAgentsSkills = loadSkills({
    dir: personalAgentsSkillsDir,
    source: "agents-skills-personal",
  });
  const projectAgentsSkillsDir = path.resolve(workspaceDir, ".agents", "skills");
  const projectAgentsSkills = loadSkills({
    dir: projectAgentsSkillsDir,
    source: "agents-skills-project",
  });
  const workspaceSkills = loadSkills({
    dir: workspaceSkillsDir,
    source: "openclaw-workspace",
  });

  const merged = new Map<string, Skill>();
  // Precedence: extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace
  for (const skill of extraSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of bundledSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of managedSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of personalAgentsSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of projectAgentsSkills) {
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
  const skillFilter = normalizeSkillFilter(opts?.skillFilter);
  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
    })),
    ...(skillFilter === undefined ? {} : { skillFilter }),
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

/**
 * Build workspace skills prompt with context-aware dynamic loading.
 *
 * When `skills.dynamicLoading.enabled` is true and a userMessage is provided,
 * this function will:
 * 1. Build a semantic index of all skills
 * 2. Search for the top-k most relevant skills based on the user message
 * 3. Return a prompt containing:
 *    - Full documentation for relevant skills only
 *    - A lightweight directory of all other skills
 *
 * This dramatically reduces token usage while maintaining skill awareness.
 *
 * Falls back to full loading if:
 * - dynamicLoading is disabled
 * - userMessage is not provided
 * - Semantic search fails
 *
 * @param workspaceDir - Workspace directory path
 * @param opts - Options including config and optional userMessage
 * @returns Skills prompt string
 */
export async function buildWorkspaceSkillsPromptAsync(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    /** If provided, only include skills with these names */
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    /** User message for context-aware skill loading */
    userMessage?: string;
  },
): Promise<string> {
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

  const dynamicConfig = opts?.config?.skills?.dynamicLoading;
  const userMessage = opts?.userMessage?.trim();

  // Check if dynamic loading should be used
  if (!dynamicConfig?.enabled || !userMessage) {
    // Fall back to standard full loading
    const remoteNote = opts?.eligibility?.remote?.note?.trim();
    return [remoteNote, formatSkillsForPrompt(promptEntries.map((entry) => entry.skill))]
      .filter(Boolean)
      .join("\n");
  }

  // Try to get or create semantic index
  const semanticIndex = await getOrCreateSemanticIndex(promptEntries, opts?.config);

  if (!semanticIndex) {
    // Fall back to full loading on index creation failure
    skillsLogger.debug("Semantic index unavailable, falling back to full loading");
    const remoteNote = opts?.eligibility?.remote?.note?.trim();
    return [remoteNote, formatSkillsForPrompt(promptEntries.map((entry) => entry.skill))]
      .filter(Boolean)
      .join("\n");
  }

  try {
    // Resolve embedding function for search
    const provider = dynamicConfig.embeddingProvider ?? "openai";
    const apiKey = resolveEmbeddingApiKey(provider, opts?.config);

    if (!apiKey) {
      throw new Error(`No API key for provider ${provider}`);
    }

    const embedFn = resolveEmbedFn(provider, apiKey, dynamicConfig.embeddingModel);

    // Search for relevant skills
    const relevantEntries = await semanticIndex.search(userMessage, embedFn, dynamicConfig.topK);

    // Get lightweight directory of all skills
    const directory = semanticIndex.getSkillDirectory();

    // Filter directory to exclude skills that are fully loaded
    const loadedNames = new Set(relevantEntries.map((e) => e.skill.name));
    const unloadedDirectory = directory.filter((d) => !loadedNames.has(d.name));

    // Build the combined prompt
    const parts: string[] = [];
    const remoteNote = opts?.eligibility?.remote?.note?.trim();

    if (remoteNote) {
      parts.push(remoteNote);
    }

    // Add fully loaded relevant skills
    if (relevantEntries.length > 0) {
      parts.push("## Loaded Skills (relevant to current context)");
      parts.push(formatSkillsForPrompt(relevantEntries.map((e) => e.skill)));
    }

    // Add lightweight directory for other skills
    if (unloadedDirectory.length > 0) {
      parts.push(formatSkillDirectory(unloadedDirectory));
    }

    const prompt = parts.filter(Boolean).join("\n\n");

    skillsLogger.debug(
      `Dynamic skill loading: ${relevantEntries.length} loaded, ` +
        `${unloadedDirectory.length} in directory`,
    );

    return prompt;
  } catch (error) {
    // Fall back to full loading on search failure
    skillsLogger.error(
      `Semantic skill search failed, falling back to full loading: ${error instanceof Error ? error.message : String(error)}`,
    );
    const remoteNote = opts?.eligibility?.remote?.note?.trim();
    return [remoteNote, formatSkillsForPrompt(promptEntries.map((entry) => entry.skill))]
      .filter(Boolean)
      .join("\n");
  }
}

/**
 * Clear the cached semantic skill index.
 * Call this when skills are added/removed or config changes.
 */
export function clearSemanticIndexCache(): void {
  cachedSemanticIndex = null;
  cachedIndexHash = null;
  skillsLogger.debug("Semantic skill index cache cleared");
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
  },
): SkillEntry[] {
  return loadSkillEntries(workspaceDir, opts);
}

function resolveUniqueSyncedSkillDirName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  let fallbackIndex = 10_000;
  let fallback = `${base}-${fallbackIndex}`;
  while (used.has(fallback)) {
    fallbackIndex += 1;
    fallback = `${base}-${fallbackIndex}`;
  }
  used.add(fallback);
  return fallback;
}

function resolveSyncedSkillDestinationPath(params: {
  targetSkillsDir: string;
  entry: SkillEntry;
  usedDirNames: Set<string>;
}): string | null {
  const sourceDirName = path.basename(params.entry.skill.baseDir).trim();
  if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") {
    return null;
  }
  const uniqueDirName = resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames);
  return resolveSandboxPath({
    filePath: uniqueDirName,
    cwd: params.targetSkillsDir,
    root: params.targetSkillsDir,
  }).resolved;
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

    const usedDirNames = new Set<string>();
    for (const entry of entries) {
      let dest: string | null = null;
      try {
        dest = resolveSyncedSkillDestinationPath({
          targetSkillsDir,
          entry,
          usedDirNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        console.warn(
          `[skills] Failed to resolve safe destination for ${entry.skill.name}: ${message}`,
        );
        continue;
      }
      if (!dest) {
        console.warn(
          `[skills] Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`,
        );
        continue;
      }
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
  entries: SkillEntry[],
  config?: OpenClawConfig,
): SkillEntry[] {
  return filterSkillEntries(entries, config);
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
