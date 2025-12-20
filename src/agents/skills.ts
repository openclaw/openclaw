import fs from "node:fs";
import path from "node:path";

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@mariozechner/pi-coding-agent";

import type { ClawdisConfig, SkillConfig } from "../config/config.js";
import { CONFIG_DIR } from "../utils.js";

export type SkillInstallSpec = {
  id?: string;
  kind: "brew" | "node" | "go" | "pnpm" | "git" | "shell";
  label?: string;
  bins?: string[];
  formula?: string;
  package?: string;
  module?: string;
  repoPath?: string;
  script?: string;
  url?: string;
  destination?: string;
  command?: string;
};

export type ClawdisSkillMetadata = {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  requires?: {
    bins?: string[];
    env?: string[];
    config?: string[];
  };
  install?: SkillInstallSpec[];
};

type ParsedSkillFrontmatter = Record<string, string>;

export type SkillEntry = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  clawdis?: ClawdisSkillMetadata;
};

export type SkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
};

function getFrontmatterValue(
  frontmatter: ParsedSkillFrontmatter,
  key: string,
): string | undefined {
  const raw = frontmatter[key];
  return typeof raw === "string" ? raw : undefined;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  const frontmatter: ParsedSkillFrontmatter = {};
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return frontmatter;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return frontmatter;
  const block = normalized.slice(4, endIndex);
  for (const line of block.split("\n")) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = stripQuotes(match[2].trim());
    if (!key || !value) continue;
    frontmatter[key] = value;
  }
  return frontmatter;
}

function normalizeStringList(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const kindRaw =
    typeof raw.kind === "string"
      ? raw.kind
      : typeof raw.type === "string"
        ? raw.type
        : "";
  const kind = kindRaw.trim().toLowerCase();
  if (
    kind !== "brew" &&
    kind !== "node" &&
    kind !== "go" &&
    kind !== "pnpm" &&
    kind !== "git" &&
    kind !== "shell"
  ) {
    return undefined;
  }

  const spec: SkillInstallSpec = {
    kind: kind as SkillInstallSpec["kind"],
  };

  if (typeof raw.id === "string") spec.id = raw.id;
  if (typeof raw.label === "string") spec.label = raw.label;
  const bins = normalizeStringList(raw.bins);
  if (bins.length > 0) spec.bins = bins;
  if (typeof raw.formula === "string") spec.formula = raw.formula;
  if (typeof raw.package === "string") spec.package = raw.package;
  if (typeof raw.module === "string") spec.module = raw.module;
  if (typeof raw.repoPath === "string") spec.repoPath = raw.repoPath;
  if (typeof raw.script === "string") spec.script = raw.script;
  if (typeof raw.url === "string") spec.url = raw.url;
  if (typeof raw.destination === "string") spec.destination = raw.destination;
  if (typeof raw.command === "string") spec.command = raw.command;

  return spec;
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
};

function resolveConfigPath(config: ClawdisConfig | undefined, pathStr: string) {
  const parts = pathStr.split(".").filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isConfigPathTruthy(
  config: ClawdisConfig | undefined,
  pathStr: string,
): boolean {
  const value = resolveConfigPath(config, pathStr);
  if (value === undefined && pathStr in DEFAULT_CONFIG_VALUES) {
    return DEFAULT_CONFIG_VALUES[pathStr] === true;
  }
  return isTruthy(value);
}

function resolveSkillConfig(
  config: ClawdisConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  const skills = config?.skills;
  if (!skills || typeof skills !== "object") return undefined;
  const entry = (skills as Record<string, SkillConfig | undefined>)[skillKey];
  if (!entry || typeof entry !== "object") return undefined;
  return entry;
}

function hasBinary(bin: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  for (const part of parts) {
    const candidate = path.join(part, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

function resolveClawdisMetadata(
  frontmatter: ParsedSkillFrontmatter,
): ClawdisSkillMetadata | undefined {
  const raw = getFrontmatterValue(frontmatter, "metadata");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { clawdis?: unknown };
    if (!parsed || typeof parsed !== "object") return undefined;
    const clawdis = (parsed as { clawdis?: unknown }).clawdis;
    if (!clawdis || typeof clawdis !== "object") return undefined;
    const clawdisObj = clawdis as Record<string, unknown>;
    const requiresRaw =
      typeof clawdisObj.requires === "object" && clawdisObj.requires !== null
        ? (clawdisObj.requires as Record<string, unknown>)
        : undefined;
    const installRaw = Array.isArray(clawdisObj.install)
      ? (clawdisObj.install as unknown[])
      : [];
    const install = installRaw
      .map((entry) => parseInstallSpec(entry))
      .filter((entry): entry is SkillInstallSpec => Boolean(entry));
    return {
      always:
        typeof clawdisObj.always === "boolean" ? clawdisObj.always : undefined,
      skillKey:
        typeof clawdisObj.skillKey === "string"
          ? clawdisObj.skillKey
          : undefined,
      primaryEnv:
        typeof clawdisObj.primaryEnv === "string"
          ? clawdisObj.primaryEnv
          : undefined,
      requires: requiresRaw
        ? {
            bins: normalizeStringList(requiresRaw.bins),
            env: normalizeStringList(requiresRaw.env),
            config: normalizeStringList(requiresRaw.config),
          }
        : undefined,
      install: install.length > 0 ? install : undefined,
    };
  } catch {
    return undefined;
  }
}

function resolveSkillKey(skill: Skill, entry?: SkillEntry): string {
  return entry?.clawdis?.skillKey ?? skill.name;
}

function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: ClawdisConfig;
}): boolean {
  const { entry, config } = params;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const skillConfig = resolveSkillConfig(config, skillKey);

  if (skillConfig?.enabled === false) return false;
  if (entry.clawdis?.always === true) {
    return true;
  }

  const requiredBins = entry.clawdis?.requires?.bins ?? [];
  if (requiredBins.length > 0) {
    for (const bin of requiredBins) {
      if (!hasBinary(bin)) return false;
    }
  }

  const requiredEnv = entry.clawdis?.requires?.env ?? [];
  if (requiredEnv.length > 0) {
    for (const envName of requiredEnv) {
      if (process.env[envName]) continue;
      if (skillConfig?.env?.[envName]) continue;
      if (skillConfig?.apiKey && entry.clawdis?.primaryEnv === envName) {
        continue;
      }
      return false;
    }
  }

  const requiredConfig = entry.clawdis?.requires?.config ?? [];
  if (requiredConfig.length > 0) {
    for (const configPath of requiredConfig) {
      if (!isConfigPathTruthy(config, configPath)) return false;
    }
  }

  return true;
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: ClawdisConfig,
): SkillEntry[] {
  return entries.filter((entry) => shouldIncludeSkill({ entry, config }));
}

export function applySkillEnvOverrides(params: {
  skills: SkillEntry[];
  config?: ClawdisConfig;
}) {
  const { skills, config } = params;
  const updates: Array<{ key: string; prev: string | undefined }> = [];

  for (const entry of skills) {
    const skillKey = resolveSkillKey(entry.skill, entry);
    const skillConfig = resolveSkillConfig(config, skillKey);
    if (!skillConfig) continue;

    if (skillConfig.env) {
      for (const [envKey, envValue] of Object.entries(skillConfig.env)) {
        if (!envValue || process.env[envKey]) continue;
        updates.push({ key: envKey, prev: process.env[envKey] });
        process.env[envKey] = envValue;
      }
    }

    const primaryEnv = entry.clawdis?.primaryEnv;
    if (primaryEnv && skillConfig.apiKey && !process.env[primaryEnv]) {
      updates.push({ key: primaryEnv, prev: process.env[primaryEnv] });
      process.env[primaryEnv] = skillConfig.apiKey;
    }
  }

  return () => {
    for (const update of updates) {
      if (update.prev === undefined) delete process.env[update.key];
      else process.env[update.key] = update.prev;
    }
  };
}

export function applySkillEnvOverridesFromSnapshot(params: {
  snapshot?: SkillSnapshot;
  config?: ClawdisConfig;
}) {
  const { snapshot, config } = params;
  if (!snapshot) return () => {};
  const updates: Array<{ key: string; prev: string | undefined }> = [];

  for (const skill of snapshot.skills) {
    const skillConfig = resolveSkillConfig(config, skill.name);
    if (!skillConfig) continue;

    if (skillConfig.env) {
      for (const [envKey, envValue] of Object.entries(skillConfig.env)) {
        if (!envValue || process.env[envKey]) continue;
        updates.push({ key: envKey, prev: process.env[envKey] });
        process.env[envKey] = envValue;
      }
    }

    if (
      skill.primaryEnv &&
      skillConfig.apiKey &&
      !process.env[skill.primaryEnv]
    ) {
      updates.push({
        key: skill.primaryEnv,
        prev: process.env[skill.primaryEnv],
      });
      process.env[skill.primaryEnv] = skillConfig.apiKey;
    }
  }

  return () => {
    for (const update of updates) {
      if (update.prev === undefined) delete process.env[update.key];
      else process.env[update.key] = update.prev;
    }
  };
}

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: ClawdisConfig;
    managedSkillsDir?: string;
  },
): SkillEntry[] {
  const managedSkillsDir =
    opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const workspaceSkillsDir = path.join(workspaceDir, "skills");

  const managedSkills = loadSkillsFromDir({
    dir: managedSkillsDir,
    source: "clawdis-managed",
  });
  const workspaceSkills = loadSkillsFromDir({
    dir: workspaceSkillsDir,
    source: "clawdis-workspace",
  });

  const merged = new Map<string, Skill>();
  for (const skill of managedSkills) merged.set(skill.name, skill);
  for (const skill of workspaceSkills) merged.set(skill.name, skill);

  const skillEntries: SkillEntry[] = Array.from(merged.values()).map(
    (skill) => {
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
        clawdis: resolveClawdisMetadata(frontmatter),
      };
    },
  );
  return skillEntries;
}

export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: {
    config?: ClawdisConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
  },
): SkillSnapshot {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(skillEntries, opts?.config);
  return {
    prompt: formatSkillsForPrompt(eligible.map((entry) => entry.skill)),
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.clawdis?.primaryEnv,
    })),
  };
}

export function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: {
    config?: ClawdisConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
  },
): string {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(skillEntries, opts?.config);
  return formatSkillsForPrompt(eligible.map((entry) => entry.skill));
}

export function loadWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: ClawdisConfig;
    managedSkillsDir?: string;
  },
): SkillEntry[] {
  return loadSkillEntries(workspaceDir, opts);
}

export function filterWorkspaceSkillEntries(
  entries: SkillEntry[],
  config?: ClawdisConfig,
): SkillEntry[] {
  return filterSkillEntries(entries, config);
}
