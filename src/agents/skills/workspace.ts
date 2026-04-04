import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolveSandboxPath } from "../sandbox-paths.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { shouldIncludeSkill } from "./config.js";
import { normalizeSkillFilter } from "./filter.js";
import { resolveOpenClawMetadata, resolveSkillInvocationPolicy } from "./frontmatter.js";
import { loadSkillsFromDirSafe, readSkillFrontmatterSafe } from "./local-loader.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import { serializeByKey } from "./serialize.js";
import { formatSkillsForPrompt, type Skill } from "./skill-contract.js";
import type {
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
} from "./types.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");

/**
 * Replace the user's home directory prefix with `~` in skill file paths
 * to reduce system prompt token usage. Models understand `~` expansion,
 * and the read tool resolves `~` to the home directory.
 *
 * Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
 *       → `~/.bun/.../skills/github/SKILL.md`
 *
 * Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
 */
function compactSkillPaths(skills: Skill[]): Skill[] {
  const home = os.homedir();
  if (!home) return skills;
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return skills.map((s) => ({
    ...s,
    filePath: s.filePath.startsWith(prefix) ? "~/" + s.filePath.slice(prefix.length) : s.filePath,
  }));
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

const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 30_000;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;

type ResolvedSkillsLimits = {
  maxCandidatesPerRoot: number;
  maxSkillsLoadedPerSource: number;
  maxSkillsInPrompt: number;
  maxSkillsPromptChars: number;
  maxSkillFileBytes: number;
};

function resolveSkillsLimits(config?: OpenClawConfig): ResolvedSkillsLimits {
  const limits = config?.skills?.limits;
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
    maxSkillsLoadedPerSource:
      limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
    maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
    maxSkillsPromptChars: limits?.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS,
    maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
  };
}

function listChildDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entry.name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            dirs.push(entry.name);
          }
        } catch {
          // ignore broken symlinks
        }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

function tryRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function warnEscapedSkillPath(params: {
  source: string;
  rootDir: string;
  candidatePath: string;
  candidateRealPath: string;
}) {
  skillsLogger.warn("Skipping skill path that resolves outside its configured root.", {
    source: params.source,
    rootDir: params.rootDir,
    path: params.candidatePath,
    realPath: params.candidateRealPath,
  });
}

function resolveContainedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
}): string | null {
  const candidateRealPath = tryRealpath(params.candidatePath);
  if (!candidateRealPath) {
    return null;
  }
  if (isPathInside(params.rootRealPath, candidateRealPath)) {
    return candidateRealPath;
  }
  warnEscapedSkillPath({
    source: params.source,
    rootDir: params.rootDir,
    candidatePath: path.resolve(params.candidatePath),
    candidateRealPath,
  });
  return null;
}

function filterLoadedSkillsInsideRoot(params: {
  skills: Skill[];
  source: string;
  rootDir: string;
  rootRealPath: string;
}): Skill[] {
  return params.skills.filter((skill) => {
    const baseDirRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir: params.rootDir,
      rootRealPath: params.rootRealPath,
      candidatePath: skill.baseDir,
    });
    if (!baseDirRealPath) {
      return false;
    }
    const skillFileRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir: params.rootDir,
      rootRealPath: params.rootRealPath,
      candidatePath: skill.filePath,
    });
    return Boolean(skillFileRealPath);
  });
}

function resolveNestedSkillsRoot(
  dir: string,
  opts?: {
    maxEntriesToScan?: number;
  },
): { baseDir: string; note?: string } {
  const nested = path.join(dir, "skills");
  try {
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
      return { baseDir: dir };
    }
  } catch {
    return { baseDir: dir };
  }

  // Heuristic: if `dir/skills/*/SKILL.md` exists for any entry, treat `dir/skills` as the real root.
  // Note: don't stop at 25, but keep a cap to avoid pathological scans.
  const nestedDirs = listChildDirectories(nested);
  const scanLimit = Math.max(0, opts?.maxEntriesToScan ?? 100);
  const toScan = scanLimit === 0 ? [] : nestedDirs.slice(0, Math.min(nestedDirs.length, scanLimit));

  for (const name of toScan) {
    const skillMd = path.join(nested, name, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      return { baseDir: nested, note: `Detected nested skills root at ${nested}` };
    }
  }
  return { baseDir: dir };
}

function unwrapLoadedSkills(loaded: unknown): Skill[] {
  if (Array.isArray(loaded)) {
    return loaded as Skill[];
  }
  if (loaded && typeof loaded === "object" && "skills" in loaded) {
    const skills = (loaded as { skills?: unknown }).skills;
    if (Array.isArray(skills)) {
      return skills as Skill[];
    }
  }
  return [];
}


type CachedSkillEntry = {
  skillDir: string;
  source: string;
  skillMdPath: string;
  skillMdRealPath: string;
  mtimeMs: number;
  size: number;
  skills: Skill[];
  lastAccessedAt: number;
};

const skillCache = new Map<string, CachedSkillEntry>();

const SKILL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_GLOBAL_SKILL_CACHE_ENTRIES = 1000;

function getSkillKey(dir: string, source: string) {
  return `${source}::${path.resolve(dir)}`;
}

function isUnderBaseDir(skillDir: string, baseDir: string): boolean {
  const resolvedSkillDir = path.resolve(skillDir);
  const resolvedBaseDir = path.resolve(baseDir);
  return (
    resolvedSkillDir === resolvedBaseDir ||
    resolvedSkillDir.startsWith(resolvedBaseDir + path.sep)
  );
}

function pruneGlobalSkillCache(now = Date.now()): void {
  for (const [key, value] of skillCache.entries()) {
    if (now - value.lastAccessedAt > SKILL_CACHE_TTL_MS) {
      skillCache.delete(key);
    }
  }

  if (skillCache.size <= MAX_GLOBAL_SKILL_CACHE_ENTRIES) {
    return;
  }

  const entriesByAge = Array.from(skillCache.entries()).sort(
    (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt,
  );

  const overflow = skillCache.size - MAX_GLOBAL_SKILL_CACHE_ENTRIES;
  for (let i = 0; i < overflow; i++) {
    skillCache.delete(entriesByAge[i][0]);
  }
}

function pruneStaleSkillCache(
  source: string,
  baseDir: string,
  seenKeys: Set<string>,
) {
  for (const [key, value] of skillCache.entries()) {
    const isSameSource = value.source === source;
    const isSameRoot = isUnderBaseDir(value.skillDir, baseDir);

    if (isSameSource && isSameRoot && !seenKeys.has(key)) {
      skillCache.delete(key);
    }
  }
}

export function loadSkills(params: {
  dir: string;
  source: string;
  limits: ResolvedSkillsLimits;
}): Skill[] {
  return loadSkillsFromCache(params);
  // Fallback path for debugging / rollback if cache logic fails
  // Currently disabled to enforce cache-first loading
  // return loadSkillsFromFile(params);
}


// Loads skills from a directory with caching semantics.
//
// This function resolves the root and handles nested skill roots, then attempts
// to read SKILL.md files in the root or immediate child directories. It uses a
// memory cache keyed by source and resolved directory path, validating file
// mtime/size to return up-to-date skill sets. Stale cache entries under the
// same source/root are pruned while keeping valid cached results for performance.
//
// The behavior mirrors `loadSkillsFromFile` but adds cache hit/miss handling
// and optimization for repeated lookups.
export function loadSkillsFromCache(params: {
  dir: string;
  source: string;
  limits: ResolvedSkillsLimits;
}): Skill[] {
  pruneGlobalSkillCache();

  const rootDir = path.resolve(params.dir);
  const rootRealPath = tryRealpath(rootDir) ?? rootDir;

  const resolved = resolveNestedSkillsRoot(params.dir, {
    maxEntriesToScan: params.limits.maxCandidatesPerRoot,
  });

  const baseDir = resolved.baseDir;
  const baseDirRealPath = resolveContainedSkillPath({
    source: params.source,
    rootDir,
    rootRealPath,
    candidatePath: baseDir,
  });
  if (!baseDirRealPath) {
    return [];
  }

  const rootSkillMd = path.join(baseDir, "SKILL.md");
  const seenKeys = new Set<string>();

  // Root skills are not cached to avoid stale results,
  // as changes in child skill files are not reflected
  // in the root SKILL.md metadata used for cache invalidation.
  if (fs.existsSync(rootSkillMd)) {
    const rootSkillRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir,
      rootRealPath: baseDirRealPath,
      candidatePath: rootSkillMd,
    });
    if (!rootSkillRealPath) {
      return [];
    }

    try {
      const size = fs.statSync(rootSkillRealPath).size;
      if (size > params.limits.maxSkillFileBytes) {
        skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
          dir: baseDir,
          filePath: rootSkillMd,
          size,
          maxSkillFileBytes: params.limits.maxSkillFileBytes,
        });
        return [];
      }

      const loaded = loadSkillsFromDirSafe({
        dir: baseDir,
        source: params.source,
        maxBytes: params.limits.maxSkillFileBytes,
      });

      const skills = filterLoadedSkillsInsideRoot({
        skills: unwrapLoadedSkills(loaded),
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
      });

      return skills;
    } catch {
      return [];
    }
  }

  const childDirs = listChildDirectories(baseDir);
  const suspicious = childDirs.length > params.limits.maxCandidatesPerRoot;

  const maxCandidates = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);

  if (suspicious) {
    skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
      dir: params.dir,
      baseDir,
      childDirCount: childDirs.length,
      maxCandidatesPerRoot: params.limits.maxCandidatesPerRoot,
      maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
    });
  } else if (childDirs.length > maxCandidates) {
    skillsLogger.warn("Skills root has many entries, truncating discovery.", {
      dir: params.dir,
      baseDir,
      childDirCount: childDirs.length,
      maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
    });
  }

  const loadedSkills: Skill[] = [];
  const now = Date.now();

  // Only consider immediate subfolders that look like skills (have SKILL.md) and are under size cap.
  for (const name of limitedChildren) {
    const skillDir = path.join(baseDir, name);
    const skillDirRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir,
      rootRealPath: baseDirRealPath,
      candidatePath: skillDir,
    });
    if (!skillDirRealPath) {
      continue;
    }

    const skillMd = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      continue;
    }

    const skillMdRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir,
      rootRealPath: baseDirRealPath,
      candidatePath: skillMd,
    });
    if (!skillMdRealPath) {
      continue;
    }

    try {
      const size = fs.statSync(skillMdRealPath).size;
      if (size > params.limits.maxSkillFileBytes) {
        skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
          skill: name,
          filePath: skillMd,
          size,
          maxSkillFileBytes: params.limits.maxSkillFileBytes,
        });
        continue;
      }

      const stat = fs.statSync(skillMd);
      const skillKey = getSkillKey(skillDir, params.source);
      seenKeys.add(skillKey);

      const cached = skillCache.get(skillKey);
      const cacheUsable =
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size &&
        cached.skillMdPath === skillMd &&
        cached.skillMdRealPath === skillMdRealPath;

      if (cacheUsable) {
        // Revalidate SKILL.md path before serving cached entries so the
        // cache-hit path preserves the same safety guarantees as the miss path.
        const revalidatedSkillMdRealPath = resolveContainedSkillPath({
          source: params.source,
          rootDir,
          rootRealPath: baseDirRealPath,
          candidatePath: skillMd,
        });

        if (revalidatedSkillMdRealPath && revalidatedSkillMdRealPath === cached.skillMdRealPath) {
          cached.lastAccessedAt = now;
          loadedSkills.push(...cached.skills);

          if (loadedSkills.length >= params.limits.maxSkillsLoadedPerSource) {
            break;
          }
          continue;
        }
      }

      const loaded = loadSkillsFromDirSafe({
        dir: skillDir,
        source: params.source,
        maxBytes: params.limits.maxSkillFileBytes,
      });

      const filteredSkills = filterLoadedSkillsInsideRoot({
        skills: unwrapLoadedSkills(loaded),
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
      });

      if (filteredSkills.length > 0) {
        skillCache.set(skillKey, {
          skillDir,
          source: params.source,
          skillMdPath: skillMd,
          skillMdRealPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          skills: filteredSkills,
          lastAccessedAt: now,
        });
      } else {
        skillCache.delete(skillKey);
      }

      loadedSkills.push(...filteredSkills);

      if (loadedSkills.length >= params.limits.maxSkillsLoadedPerSource) {
        break;
      }
    } catch {
      continue;
    }
  }

  pruneStaleSkillCache(params.source, baseDir, seenKeys);

  if (loadedSkills.length > params.limits.maxSkillsLoadedPerSource) {
    return loadedSkills
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, params.limits.maxSkillsLoadedPerSource);
  }

  return loadedSkills;
}

export function loadSkillsFromFile(params: {
  dir: string;
  source: string;
  limits: ResolvedSkillsLimits;
}): Skill[] {
  const rootDir = path.resolve(params.dir);
  const rootRealPath = tryRealpath(rootDir) ?? rootDir;
  const resolved = resolveNestedSkillsRoot(params.dir, {
    maxEntriesToScan: params.limits.maxCandidatesPerRoot,
  });
  const baseDir = resolved.baseDir;
  const baseDirRealPath = resolveContainedSkillPath({
    source: params.source,
    rootDir,
    rootRealPath,
    candidatePath: baseDir,
  });
  if (!baseDirRealPath) {
    return [];
  }

  // If the root itself is a skill directory, just load it directly (but enforce size cap).
  const rootSkillMd = path.join(baseDir, "SKILL.md");
  if (fs.existsSync(rootSkillMd)) {
    const rootSkillRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir,
      rootRealPath: baseDirRealPath,
      candidatePath: rootSkillMd,
    });
    if (!rootSkillRealPath) {
      return [];
    }
    try {
      const size = fs.statSync(rootSkillRealPath).size;
      if (size > params.limits.maxSkillFileBytes) {
        skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
          dir: baseDir,
          filePath: rootSkillMd,
          size,
          maxSkillFileBytes: params.limits.maxSkillFileBytes,
        });
        return [];
      }
    } catch {
      return [];
    }

    const loaded = loadSkillsFromDirSafe({
      dir: baseDir,
      source: params.source,
      maxBytes: params.limits.maxSkillFileBytes,
    });
    return filterLoadedSkillsInsideRoot({
      skills: unwrapLoadedSkills(loaded),
      source: params.source,
      rootDir,
      rootRealPath: baseDirRealPath,
    });
  }

  const childDirs = listChildDirectories(baseDir);
  const suspicious = childDirs.length > params.limits.maxCandidatesPerRoot;

  const maxCandidates = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);

  if (suspicious) {
    skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
      dir: params.dir,
      baseDir,
      childDirCount: childDirs.length,
      maxCandidatesPerRoot: params.limits.maxCandidatesPerRoot,
      maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
    });
  } else if (childDirs.length > maxCandidates) {
    skillsLogger.warn("Skills root has many entries, truncating discovery.", {
      dir: params.dir,
      baseDir,
      childDirCount: childDirs.length,
      maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
    });
  }

  const loadedSkills: Skill[] = [];

  // Only consider immediate subfolders that look like skills (have SKILL.md) and are under size cap.
  for (const name of limitedChildren) {
    const skillDir = path.join(baseDir, name);
    const skillDirRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir,
      rootRealPath: baseDirRealPath,
      candidatePath: skillDir,
    });
    if (!skillDirRealPath) {
      continue;
    }
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      continue;
    }
    const skillMdRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir,
      rootRealPath: baseDirRealPath,
      candidatePath: skillMd,
    });
    if (!skillMdRealPath) {
      continue;
    }
    try {
      const size = fs.statSync(skillMdRealPath).size;
      if (size > params.limits.maxSkillFileBytes) {
        skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
          skill: name,
          filePath: skillMd,
          size,
          maxSkillFileBytes: params.limits.maxSkillFileBytes,
        });
        continue;
      }
    } catch {
      continue;
    }

    const loaded = loadSkillsFromDirSafe({
      dir: skillDir,
      source: params.source,
      maxBytes: params.limits.maxSkillFileBytes,
    });
    loadedSkills.push(
      ...filterLoadedSkillsInsideRoot({
        skills: unwrapLoadedSkills(loaded),
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
      }),
    );

    if (loadedSkills.length >= params.limits.maxSkillsLoadedPerSource) {
      break;
    }
  }

  if (loadedSkills.length > params.limits.maxSkillsLoadedPerSource) {
    return loadedSkills
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, params.limits.maxSkillsLoadedPerSource);
  }

  return loadedSkills;
}

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntry[] {
  const limits = resolveSkillsLimits(opts?.config);



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
      limits: limits,
    })
    : [];
  const extraSkills = mergedExtraDirs.flatMap((dir) => {
    const resolved = resolveUserPath(dir);
    return loadSkills({
      dir: resolved,
      source: "openclaw-extra",
      limits: limits,
    });
  });
  const managedSkills = loadSkills({
    dir: managedSkillsDir,
    source: "openclaw-managed",
    limits: limits,
  });
  const personalAgentsSkillsDir = path.resolve(os.homedir(), ".agents", "skills");
  const personalAgentsSkills = loadSkills({
    dir: personalAgentsSkillsDir,
    source: "agents-skills-personal",
    limits: limits,
  });
  const projectAgentsSkillsDir = path.resolve(workspaceDir, ".agents", "skills");
  const projectAgentsSkills = loadSkills({
    dir: projectAgentsSkillsDir,
    source: "agents-skills-project",
    limits: limits,
  });
  const workspaceSkills = loadSkills({
    dir: workspaceSkillsDir,
    source: "openclaw-workspace",
    limits: limits,
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
    const frontmatter =
      readSkillFrontmatterSafe({
        rootDir: skill.baseDir,
        filePath: skill.filePath,
        maxBytes: limits.maxSkillFileBytes,
      }) ?? ({} as ParsedSkillFrontmatter);
    return {
      skill,
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
  });
  return skillEntries;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Compact skill catalog: name + location only (no description).
 * Used as a fallback when the full format exceeds the char budget,
 * preserving awareness of all skills before resorting to dropping.
 */
export function formatSkillsCompact(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its name.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

// Budget reserved for the compact-mode warning line prepended by the caller.
const COMPACT_WARNING_OVERHEAD = 150;

function applySkillsPromptLimits(params: { skills: Skill[]; config?: OpenClawConfig }): {
  skillsForPrompt: Skill[];
  truncated: boolean;
  compact: boolean;
} {
  const limits = resolveSkillsLimits(params.config);
  const total = params.skills.length;
  const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));

  let skillsForPrompt = byCount;
  let truncated = total > byCount.length;
  let compact = false;

  const fitsFull = (skills: Skill[]): boolean =>
    formatSkillsForPrompt(skills).length <= limits.maxSkillsPromptChars;

  // Reserve space for the warning line the caller prepends in compact mode.
  const compactBudget = limits.maxSkillsPromptChars - COMPACT_WARNING_OVERHEAD;
  const fitsCompact = (skills: Skill[]): boolean =>
    formatSkillsCompact(skills).length <= compactBudget;

  if (!fitsFull(skillsForPrompt)) {
    // Full format exceeds budget. Try compact (name + location, no description)
    // to preserve awareness of all skills before dropping any.
    if (fitsCompact(skillsForPrompt)) {
      compact = true;
      // No skills dropped — only format downgraded. Preserve existing truncated state.
    } else {
      // Compact still too large — binary search the largest prefix that fits.
      compact = true;
      let lo = 0;
      let hi = skillsForPrompt.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(skillsForPrompt.slice(0, mid))) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      skillsForPrompt = skillsForPrompt.slice(0, lo);
      truncated = true;
    }
  }

  return { skillsForPrompt, truncated, compact };
}

export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): SkillSnapshot {
  const { eligible, prompt, resolvedSkills } = resolveWorkspaceSkillPromptState(workspaceDir, opts);
  const skillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),
    })),
    ...(skillFilter === undefined ? {} : { skillFilter }),
    resolvedSkills,
    version: opts?.snapshotVersion,
  };
}

export function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): string {
  return resolveWorkspaceSkillPromptState(workspaceDir, opts).prompt;
}

type WorkspaceSkillBuildOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  entries?: SkillEntry[];
  agentId?: string;
  /** If provided, only include skills with these names */
  skillFilter?: string[];
  eligibility?: SkillEligibilityContext;
};

function resolveEffectiveWorkspaceSkillFilter(
  opts?: WorkspaceSkillBuildOptions,
): string[] | undefined {
  if (opts?.skillFilter !== undefined) {
    return normalizeSkillFilter(opts.skillFilter);
  }
  if (!opts?.config || !opts.agentId) {
    return undefined;
  }
  return resolveEffectiveAgentSkillFilter(opts.config, opts.agentId);
}

function resolveWorkspaceSkillPromptState(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): {
  eligible: SkillEntry[];
  prompt: string;
  resolvedSkills: Skill[];
} {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    effectiveSkillFilter,
    opts?.eligibility,
  );
  const promptEntries = eligible.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  );
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const resolvedSkills = promptEntries.map((entry) => entry.skill);
  // Derive prompt-facing skills with compacted paths (e.g. ~/...) once.
  // Budget checks and final render both use this same representation so the
  // tier decision is based on the exact strings that end up in the prompt.
  // resolvedSkills keeps canonical paths for snapshot / runtime consumers.
  const promptSkills = compactSkillPaths(resolvedSkills);
  const { skillsForPrompt, truncated, compact } = applySkillsPromptLimits({
    skills: promptSkills,
    config: opts?.config,
  });
  const truncationNote = truncated
    ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${resolvedSkills.length}${compact ? " (compact format, descriptions omitted)" : ""}. Run \`openclaw skills check\` to audit.`
    : compact
      ? `⚠️ Skills catalog using compact format (descriptions omitted). Run \`openclaw skills check\` to audit.`
      : "";
  const prompt = [
    remoteNote,
    truncationNote,
    compact ? formatSkillsCompact(skillsForPrompt) : formatSkillsForPrompt(skillsForPrompt),
  ]
    .filter(Boolean)
    .join("\n");
  return { eligible, prompt, resolvedSkills };
}

export function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId?: string;
}): string {
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (snapshotPrompt) {
    return snapshotPrompt;
  }
  if (params.entries && params.entries.length > 0) {
    const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
      agentId: params.agentId,
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
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  const entries = loadSkillEntries(workspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  if (effectiveSkillFilter === undefined) {
    return entries;
  }
  return filterSkillEntries(entries, opts?.config, effectiveSkillFilter, opts?.eligibility);
}

export function loadVisibleWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  const entries = loadSkillEntries(workspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return filterSkillEntries(entries, opts?.config, effectiveSkillFilter, opts?.eligibility);
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
  skillFilter?: string[];
  agentId?: string;
  eligibility?: SkillEligibilityContext;
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

    const entries = loadWorkspaceSkillEntries(sourceDir, {
      config: params.config,
      skillFilter: params.skillFilter,
      agentId: params.agentId,
      eligibility: params.eligibility,
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
        skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
        continue;
      }
      if (!dest) {
        skillsLogger.warn(
          `Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`,
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
        skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
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

export function filterWorkspaceSkillEntriesWithOptions(
  entries: SkillEntry[],
  opts?: {
    config?: OpenClawConfig;
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  return filterSkillEntries(entries, opts?.config, opts?.skillFilter, opts?.eligibility);
}
