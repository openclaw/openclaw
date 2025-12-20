import path from "node:path";

import type { ClawdisConfig } from "../config/config.js";
import { CONFIG_DIR } from "../utils.js";
import {
  hasBinary,
  isConfigPathTruthy,
  loadWorkspaceSkillEntries,
  resolveConfigPath,
  resolveSkillConfig,
  type SkillEntry,
  type SkillInstallSpec,
} from "./skills.js";

export type SkillStatusConfigCheck = {
  path: string;
  value: unknown;
  satisfied: boolean;
};

export type SkillInstallOption = {
  id: string;
  kind: SkillInstallSpec["kind"];
  label: string;
  bins: string[];
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  always: boolean;
  disabled: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    env: string[];
    config: string[];
  };
  missing: {
    bins: string[];
    env: string[];
    config: string[];
  };
  configChecks: SkillStatusConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

function resolveSkillKey(entry: SkillEntry): string {
  return entry.clawdis?.skillKey ?? entry.skill.name;
}

function normalizeInstallOptions(entry: SkillEntry): SkillInstallOption[] {
  const install = entry.clawdis?.install ?? [];
  if (install.length === 0) return [];
  return install.map((spec, index) => {
    const id = (spec.id ?? `${spec.kind}-${index}`).trim();
    const bins = spec.bins ?? [];
    let label = (spec.label ?? "").trim();
    if (!label) {
      if (spec.kind === "brew" && spec.formula) {
        label = `Install ${spec.formula} (brew)`;
      } else if (spec.kind === "node" && spec.package) {
        label = `Install ${spec.package} (node)`;
      } else if (spec.kind === "go" && spec.module) {
        label = `Install ${spec.module} (go)`;
      } else if (spec.kind === "pnpm" && spec.repoPath) {
        label = `Install ${spec.repoPath} (pnpm)`;
      } else if (spec.kind === "git" && spec.url) {
        label = `Clone ${spec.url}`;
      } else {
        label = "Run installer";
      }
    }
    return {
      id,
      kind: spec.kind,
      label,
      bins,
    };
  });
}

function buildSkillStatus(entry: SkillEntry, config?: ClawdisConfig): SkillStatusEntry {
  const skillKey = resolveSkillKey(entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const always = entry.clawdis?.always === true;

  const requiredBins = entry.clawdis?.requires?.bins ?? [];
  const requiredEnv = entry.clawdis?.requires?.env ?? [];
  const requiredConfig = entry.clawdis?.requires?.config ?? [];

  const missingBins = requiredBins.filter((bin) => !hasBinary(bin));

  const missingEnv: string[] = [];
  for (const envName of requiredEnv) {
    if (process.env[envName]) continue;
    if (skillConfig?.env?.[envName]) continue;
    if (skillConfig?.apiKey && entry.clawdis?.primaryEnv === envName) {
      continue;
    }
    missingEnv.push(envName);
  }

  const configChecks: SkillStatusConfigCheck[] = requiredConfig.map((pathStr) => {
    const value = resolveConfigPath(config, pathStr);
    const satisfied = isConfigPathTruthy(config, pathStr);
    return { path: pathStr, value, satisfied };
  });
  const missingConfig = configChecks
    .filter((check) => !check.satisfied)
    .map((check) => check.path);

  const missing = always
    ? { bins: [], env: [], config: [] }
    : { bins: missingBins, env: missingEnv, config: missingConfig };
  const eligible =
    !disabled &&
    (always ||
      (missing.bins.length === 0 &&
        missing.env.length === 0 &&
        missing.config.length === 0));

  return {
    name: entry.skill.name,
    description: entry.skill.description,
    source: entry.skill.source,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
    skillKey,
    primaryEnv: entry.clawdis?.primaryEnv,
    always,
    disabled,
    eligible,
    requirements: {
      bins: requiredBins,
      env: requiredEnv,
      config: requiredConfig,
    },
    missing,
    configChecks,
    install: normalizeInstallOptions(entry),
  };
}

export function buildWorkspaceSkillStatus(
  workspaceDir: string,
  opts?: {
    config?: ClawdisConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
  },
): SkillStatusReport {
  const managedSkillsDir =
    opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const skillEntries =
    opts?.entries ?? loadWorkspaceSkillEntries(workspaceDir, opts);
  return {
    workspaceDir,
    managedSkillsDir,
    skills: skillEntries.map((entry) => buildSkillStatus(entry, opts?.config)),
  };
}
