import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig, SkillConfig } from "../../config/config.js";
import {
  evaluateRuntimeRequires,
  hasBinary,
  isConfigPathTruthyWithDefaults,
  resolveConfigPath,
  resolveRuntimePlatform,
} from "../../shared/config-eval.js";
import { resolveSkillKey } from "./frontmatter.js";
import type { SkillEligibilityContext, SkillEntry } from "./types.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "browser.evaluateEnabled": true,
};

const CLAWHUB_LOCK_RELATIVE_PATH = path.join(".clawhub", "lock.json");
const CLAWHUB_SOURCE = "openclaw-workspace";
const CLAWHUB_CACHE_TTL_MS = 2_000;

type ClawhubCacheEntry = {
  loadedAtMs: number;
  mtimeMs: number;
  names: Set<string>;
};

const clawhubLockCache = new Map<string, ClawhubCacheEntry>();

export { hasBinary, resolveConfigPath, resolveRuntimePlatform };

export function isConfigPathTruthy(config: OpenClawConfig | undefined, pathStr: string): boolean {
  return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}

export function resolveSkillConfig(
  config: OpenClawConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  const skills = config?.skills?.entries;
  if (!skills || typeof skills !== "object") {
    return undefined;
  }
  const entry = (skills as Record<string, SkillConfig | undefined>)[skillKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry;
}

function normalizeAllowlist(input: unknown): string[] | undefined {
  if (!input) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.map((entry) => String(entry).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

const BUNDLED_SOURCES = new Set(["openclaw-bundled"]);

function isBundledSkill(entry: SkillEntry): boolean {
  return BUNDLED_SOURCES.has(entry.skill.source);
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase();
}

function addSkillNameVariants(names: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = normalizeSkillName(value);
  if (!normalized) {
    return;
  }
  names.add(normalized);
  names.add(normalized.replace(/_/g, "-"));
  names.add(normalized.replace(/-/g, "_"));
}

function collectClawhubSkillNames(value: unknown, names: Set<string>, depth = 0): void {
  if (!value || depth > 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectClawhubSkillNames(item, names, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  const keyBuckets = ["skills", "entries", "installs"];
  for (const bucket of keyBuckets) {
    const nested = record[bucket];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      continue;
    }
    for (const key of Object.keys(nested as Record<string, unknown>)) {
      addSkillNameVariants(names, key);
    }
  }
  addSkillNameVariants(names, record.slug);
  addSkillNameVariants(names, record.name);
  addSkillNameVariants(names, record.skill);
  addSkillNameVariants(names, record.id);
  addSkillNameVariants(names, record.folder);
  addSkillNameVariants(names, record.dir);
  if (typeof record.path === "string") {
    addSkillNameVariants(names, path.basename(record.path));
  }
  if (typeof record.installPath === "string") {
    addSkillNameVariants(names, path.basename(record.installPath));
  }

  for (const nested of Object.values(record)) {
    collectClawhubSkillNames(nested, names, depth + 1);
  }
}

function resolveWorkspaceDirForWorkspaceSkill(entry: SkillEntry): string | undefined {
  if (entry.skill.source !== CLAWHUB_SOURCE) {
    return undefined;
  }
  const skillDir = path.dirname(entry.skill.filePath);
  const skillsDir = path.dirname(skillDir);
  if (path.basename(skillsDir) !== "skills") {
    return undefined;
  }
  return path.dirname(skillsDir);
}

function loadClawhubSkillNames(workspaceDir: string): Set<string> {
  const lockPath = path.join(workspaceDir, CLAWHUB_LOCK_RELATIVE_PATH);
  const now = Date.now();
  const cached = clawhubLockCache.get(lockPath);
  if (cached && now - cached.loadedAtMs <= CLAWHUB_CACHE_TTL_MS) {
    return cached.names;
  }

  try {
    const stat = fs.statSync(lockPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      cached.loadedAtMs = now;
      return cached.names;
    }
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const names = new Set<string>();
    collectClawhubSkillNames(parsed, names);
    clawhubLockCache.set(lockPath, {
      loadedAtMs: now,
      mtimeMs: stat.mtimeMs,
      names,
    });
    return names;
  } catch {
    clawhubLockCache.delete(lockPath);
    return new Set<string>();
  }
}

export function resolveBundledAllowlist(config?: OpenClawConfig): string[] | undefined {
  return normalizeAllowlist(config?.skills?.allowBundled);
}

export function isBundledSkillAllowed(entry: SkillEntry, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  if (!isBundledSkill(entry)) {
    return true;
  }
  const key = resolveSkillKey(entry.skill, entry);
  return allowlist.includes(key) || allowlist.includes(entry.skill.name);
}

export function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  eligibility?: SkillEligibilityContext;
}): boolean {
  const { entry, config, eligibility } = params;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);
  const osList = entry.metadata?.os ?? [];
  const remotePlatforms = eligibility?.remote?.platforms ?? [];

  if (skillConfig?.enabled === false) {
    return false;
  }
  if (isSkillQuarantinedByDefault({ entry, skillKey, skillConfig })) {
    return false;
  }
  if (!isBundledSkillAllowed(entry, allowBundled)) {
    return false;
  }
  if (
    osList.length > 0 &&
    !osList.includes(resolveRuntimePlatform()) &&
    !remotePlatforms.some((platform) => osList.includes(platform))
  ) {
    return false;
  }
  if (entry.metadata?.always === true) {
    return true;
  }

  return evaluateRuntimeRequires({
    requires: entry.metadata?.requires,
    hasBin: hasBinary,
    hasRemoteBin: eligibility?.remote?.hasBin,
    hasAnyRemoteBin: eligibility?.remote?.hasAnyBin,
    hasEnv: (envName) =>
      Boolean(
        process.env[envName] ||
        skillConfig?.env?.[envName] ||
        (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
      ),
    isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath),
  });
}

export function isSkillQuarantinedByDefault(params: {
  entry: SkillEntry;
  skillKey: string;
  skillConfig: SkillConfig | undefined;
}): boolean {
  if (params.skillConfig?.enabled === true) {
    return false;
  }
  const workspaceDir = resolveWorkspaceDirForWorkspaceSkill(params.entry);
  if (!workspaceDir) {
    return false;
  }
  const names = loadClawhubSkillNames(workspaceDir);
  if (names.size === 0) {
    return false;
  }
  return (
    names.has(normalizeSkillName(params.entry.skill.name)) ||
    names.has(normalizeSkillName(params.skillKey))
  );
}
