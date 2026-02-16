import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";
import { evaluateEntryMetadataRequirements } from "../shared/entry-status.js";
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
  requirements: Requirements;
  missing: Requirements;
  configChecks: SkillStatusConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

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

  const brewAvailable = hasBinary("brew");

  if (prefs.preferBrew && brewAvailable && brewSpec) {
    return brewSpec;
  }
  if (uvSpec) {
    return uvSpec;
  }
  if (nodeSpec) {
    return nodeSpec;
  }
  // Only prefer brew when it is actually installed; otherwise skip to
  // alternatives so Linux/Docker environments without brew get a working
  // install option instead of a guaranteed failure.
  if (brewSpec && brewAvailable) {
    return brewSpec;
  }
  if (goSpec) {
    return goSpec;
  }
  // Prefer download over an unavailable brew spec.
  const downloadSpec = findKind("download");
  if (downloadSpec) {
    return downloadSpec;
  }
  // Last resort: return brew spec even without brew so the caller can
  // surface a descriptive error rather than "no installer found".
  if (brewSpec) {
    return brewSpec;
  }
  return indexed[0];
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
): SkillStatusEntry {
  const skillKey = resolveSkillKey(entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const allowBundled = resolveBundledAllowlist(config);
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const always = entry.metadata?.always === true;
  const bundled =
    bundledNames && bundledNames.size > 0
      ? bundledNames.has(entry.skill.name)
      : entry.skill.source === "openclaw-bundled";

  const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } =
    evaluateEntryMetadataRequirements({
      always,
      metadata: entry.metadata,
      frontmatter: entry.frontmatter,
      hasLocalBin: hasBinary,
      localPlatform: process.platform,
      remote: eligibility?.remote,
      isEnvSatisfied: (envName) =>
        Boolean(
          process.env[envName] ||
          skillConfig?.env?.[envName] ||
          (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
        ),
      isConfigSatisfied: (pathStr) => isConfigPathTruthy(config, pathStr),
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
    skills: skillEntries.map((entry) =>
      buildSkillStatus(entry, opts?.config, prefs, opts?.eligibility, bundledContext.names),
    ),
  };
}
