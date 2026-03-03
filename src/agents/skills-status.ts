import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../shared/entry-status.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";
import { CONFIG_DIR } from "../utils.js";
import {
  hasBinary,
  isBundledSkillAllowed,
  isConfigPathTruthy,
  loadWorkspaceSkillEntries,
  resolveBundledAllowlist,
  resolveSkillConfig,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillEligibilityContext,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";
import { resolveBundledSkillsContext } from "./skills/bundled-context.js";

export type SkillStatusConfigCheck = RequirementConfigCheck;

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
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  type: "default" | "optional";
  selectedByAgents: string[];
  requirements: Requirements;
  missing: Requirements;
  configChecks: SkillStatusConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  defaultSkills: string[];
  skills: SkillStatusEntry[];
};

function normalizeSkillNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of raw) {
    const name = String(value).trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function resolveSelectedByAgents(config?: OpenClawConfig): Map<string, string[]> {
  const bySkill = new Map<string, string[]>();
  const agents = config?.agents?.list;
  if (!Array.isArray(agents)) {
    return bySkill;
  }
  for (const agent of agents) {
    const agentId = typeof agent?.id === "string" ? agent.id.trim() : "";
    if (!agentId || !Array.isArray(agent.skills)) {
      continue;
    }
    const normalizedSkills = normalizeSkillNames(agent.skills);
    for (const skillName of normalizedSkills) {
      const existing = bySkill.get(skillName);
      if (existing) {
        existing.push(agentId);
      } else {
        bySkill.set(skillName, [agentId]);
      }
    }
  }
  for (const [skillName, agentIds] of bySkill.entries()) {
    bySkill.set(skillName, Array.from(new Set(agentIds)).toSorted());
  }
  return bySkill;
}

function resolveSkillKey(entry: SkillEntry): string {
  return entry.metadata?.skillKey ?? entry.skill.name;
}

function selectPreferredInstallSpec(
  install: SkillInstallSpec[],
  prefs: SkillsInstallPreferences,
): { spec: SkillInstallSpec; index: number } | undefined {
  if (install.length === 0) {
    return undefined;
  }

  const indexed = install.map((spec, index) => ({ spec, index }));
  const findKind = (kind: SkillInstallSpec["kind"]) =>
    indexed.find((item) => item.spec.kind === kind);

  const brewSpec = findKind("brew");
  const nodeSpec = findKind("node");
  const goSpec = findKind("go");
  const uvSpec = findKind("uv");
  const downloadSpec = findKind("download");
  const brewAvailable = hasBinary("brew");

  // Table-driven preference chain; first match wins.
  const pickers: Array<() => { spec: SkillInstallSpec; index: number } | undefined> = [
    () => (prefs.preferBrew && brewAvailable ? brewSpec : undefined),
    () => uvSpec,
    () => nodeSpec,
    // Only prefer brew when available to avoid guaranteed failure on Linux/Docker.
    () => (brewAvailable ? brewSpec : undefined),
    () => goSpec,
    // Prefer download over an unavailable brew spec.
    () => downloadSpec,
    // Last resort: surface descriptive brew-missing error instead of "no installer found".
    () => brewSpec,
    () => indexed[0],
  ];

  for (const pick of pickers) {
    const selected = pick();
    if (selected) {
      return selected;
    }
  }

  return undefined;
}

function normalizeInstallOptions(
  entry: SkillEntry,
  prefs: SkillsInstallPreferences,
): SkillInstallOption[] {
  // If the skill is explicitly OS-scoped, don't surface install actions on unsupported platforms.
  // (Installers run locally; remote OS eligibility is handled separately.)
  const requiredOs = entry.metadata?.os ?? [];
  if (requiredOs.length > 0 && !requiredOs.includes(process.platform)) {
    return [];
  }

  const install = entry.metadata?.install ?? [];
  if (install.length === 0) {
    return [];
  }

  const platform = process.platform;
  const filtered = install.filter((spec) => {
    const osList = spec.os ?? [];
    return osList.length === 0 || osList.includes(platform);
  });
  if (filtered.length === 0) {
    return [];
  }

  const toOption = (spec: SkillInstallSpec, index: number): SkillInstallOption => {
    const id = (spec.id ?? `${spec.kind}-${index}`).trim();
    const bins = spec.bins ?? [];
    let label = (spec.label ?? "").trim();
    if (spec.kind === "node" && spec.package) {
      label = `Install ${spec.package} (${prefs.nodeManager})`;
    }
    if (!label) {
      if (spec.kind === "brew" && spec.formula) {
        label = `Install ${spec.formula} (brew)`;
      } else if (spec.kind === "node" && spec.package) {
        label = `Install ${spec.package} (${prefs.nodeManager})`;
      } else if (spec.kind === "go" && spec.module) {
        label = `Install ${spec.module} (go)`;
      } else if (spec.kind === "uv" && spec.package) {
        label = `Install ${spec.package} (uv)`;
      } else if (spec.kind === "download" && spec.url) {
        const url = spec.url.trim();
        const last = url.split("/").pop();
        label = `Download ${last && last.length > 0 ? last : url}`;
      } else {
        label = "Run installer";
      }
    }
    return { id, kind: spec.kind, label, bins };
  };

  const allDownloads = filtered.every((spec) => spec.kind === "download");
  if (allDownloads) {
    return filtered.map((spec, index) => toOption(spec, index));
  }

  const preferred = selectPreferredInstallSpec(filtered, prefs);
  if (!preferred) {
    return [];
  }
  return [toOption(preferred.spec, preferred.index)];
}

function buildSkillStatus(
  entry: SkillEntry,
  config?: OpenClawConfig,
  prefs?: SkillsInstallPreferences,
  eligibility?: SkillEligibilityContext,
  bundledNames?: Set<string>,
  defaultSkillSet?: ReadonlySet<string>,
  selectedByAgentsBySkill?: ReadonlyMap<string, string[]>,
): SkillStatusEntry {
  const skillKey = resolveSkillKey(entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const allowBundled = resolveBundledAllowlist(config);
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const always = entry.metadata?.always === true;
  const type = defaultSkillSet?.has(entry.skill.name) ? "default" : "optional";
  const selectedByAgents = selectedByAgentsBySkill?.get(entry.skill.name) ?? [];
  const isEnvSatisfied = (envName: string) =>
    Boolean(
      process.env[envName] ||
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
    );
  const isConfigSatisfied = (pathStr: string) => isConfigPathTruthy(config, pathStr);
  const bundled =
    bundledNames && bundledNames.size > 0
      ? bundledNames.has(entry.skill.name)
      : entry.skill.source === "openclaw-bundled";

  const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } =
    evaluateEntryRequirementsForCurrentPlatform({
      always,
      entry,
      hasLocalBin: hasBinary,
      remote: eligibility?.remote,
      isEnvSatisfied,
      isConfigSatisfied,
    });
  const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied;

  return {
    name: entry.skill.name,
    description: entry.skill.description,
    source: entry.skill.source,
    bundled,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
    skillKey,
    primaryEnv: entry.metadata?.primaryEnv,
    emoji,
    homepage,
    always,
    disabled,
    blockedByAllowlist,
    eligible,
    type,
    selectedByAgents,
    requirements: required,
    missing,
    configChecks,
    install: normalizeInstallOptions(entry, prefs ?? resolveSkillsInstallPreferences(config)),
  };
}

export function buildWorkspaceSkillStatus(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
    eligibility?: SkillEligibilityContext;
  },
): SkillStatusReport {
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const defaultSkills = normalizeSkillNames(opts?.config?.agents?.defaults?.skills);
  const defaultSkillSet = new Set(defaultSkills);
  const selectedByAgentsBySkill = resolveSelectedByAgents(opts?.config);
  const bundledContext = resolveBundledSkillsContext();
  const skillEntries =
    opts?.entries ??
    loadWorkspaceSkillEntries(workspaceDir, {
      config: opts?.config,
      managedSkillsDir,
      bundledSkillsDir: bundledContext.dir,
    });
  const prefs = resolveSkillsInstallPreferences(opts?.config);
  return {
    workspaceDir,
    managedSkillsDir,
    defaultSkills,
    skills: skillEntries.map((entry) =>
      buildSkillStatus(
        entry,
        opts?.config,
        prefs,
        opts?.eligibility,
        bundledContext.names,
        defaultSkillSet,
        selectedByAgentsBySkill,
      ),
    ),
  };
}
