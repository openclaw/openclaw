import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../shared/entry-status.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
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
import { resolveEffectiveAgentSkillFilter } from "./skills/agent-filter.js";
import { resolveBundledSkillsContext } from "./skills/bundled-context.js";
import { resolveSkillSource } from "./skills/source.js";

export type SkillStatusConfigCheck = RequirementConfigCheck;

export type SkillInstallOption = {
  id: string;
  kind: SkillInstallSpec["kind"];
  label: string;
  bins: string[];
};

export type SkillTrustSource = "openclaw-bundled" | "clawhub" | "trusted-dir" | "local";

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  trustSource: SkillTrustSource;
  untrustedLocalSource: boolean;
  trustWarning?: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  blockedByAgentFilter: boolean;
  eligible: boolean;
  modelVisible: boolean;
  userInvocable: boolean;
  commandVisible: boolean;
  requirements: Requirements;
  missing: Requirements;
  configChecks: SkillStatusConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  agentId?: string;
  agentSkillFilter?: string[];
  skills: SkillStatusEntry[];
};

type SkillTrustContext = {
  trustedDirRealPaths: string[];
};

type SkillTrustStatus = {
  trustSource: SkillTrustSource;
  untrustedLocalSource: boolean;
  trustWarning?: string;
};

const LOCAL_SKILL_SOURCES = new Set([
  "openclaw-workspace",
  "agents-skills-project",
  "agents-skills-personal",
  "openclaw-managed",
  "openclaw-extra",
  "unknown",
]);

const UNTRUSTED_LOCAL_SKILL_WARNING =
  "Loaded from a local skill source without ClawHub origin metadata or a matching skills.load.trustedDirs entry. Review SKILL.md before enabling or invoking this skill.";

const CLAWHUB_ORIGIN_RELATIVE_PATHS = [
  path.join(".clawhub", "origin.json"),
  path.join(".clawdhub", "origin.json"),
];

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

function isSkillVisibleInAvailableSkillsPrompt(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return (
      entry.exposure.includeInAvailableSkillsPrompt ||
      !("includeInAvailableSkillsPrompt" in entry.exposure)
    );
  }
  if (entry.invocation) {
    return !entry.invocation.disableModelInvocation;
  }
  return !entry.skill.disableModelInvocation;
}

function isSkillUserInvocable(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return entry.exposure.userInvocable || !("userInvocable" in entry.exposure);
  }
  if (entry.invocation) {
    return entry.invocation.userInvocable || !("userInvocable" in entry.invocation);
  }
  return true;
}

function tryRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveTrustedSkillDirRealPaths(config?: OpenClawConfig): string[] {
  const rawDirs = config?.skills?.load?.trustedDirs ?? [];
  return rawDirs
    .map((dir) => normalizeOptionalString(dir) ?? "")
    .filter(Boolean)
    .map((dir) => tryRealpath(resolveUserPath(dir)))
    .filter((dir): dir is string => Boolean(dir))
    .filter((dir, index, all) => all.indexOf(dir) === index);
}

function readClawHubOriginMarker(baseDir: string): boolean {
  for (const relativePath of CLAWHUB_ORIGIN_RELATIVE_PATHS) {
    const candidate = path.join(baseDir, relativePath);
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as Partial<{
        version: unknown;
        registry: unknown;
        slug: unknown;
        installedVersion: unknown;
        installedAt: unknown;
      }>;
      if (
        raw.version === 1 &&
        typeof raw.registry === "string" &&
        typeof raw.slug === "string" &&
        typeof raw.installedVersion === "string" &&
        typeof raw.installedAt === "number"
      ) {
        return true;
      }
    } catch {
      // Missing or malformed origin metadata is handled as an untrusted local source.
    }
  }
  return false;
}

function isTrustedSkillDir(baseDir: string, context: SkillTrustContext): boolean {
  if (context.trustedDirRealPaths.length === 0) {
    return false;
  }
  const baseDirRealPath = tryRealpath(baseDir) ?? path.resolve(baseDir);
  return context.trustedDirRealPaths.some(
    (root) => isPathInside(root, baseDirRealPath) || isPathInsideOrEqual(root, baseDirRealPath),
  );
}

function resolveSkillTrustStatus(
  entry: SkillEntry,
  params: {
    bundled: boolean;
    source: string;
    context: SkillTrustContext;
  },
): SkillTrustStatus {
  if (params.bundled) {
    return { trustSource: "openclaw-bundled", untrustedLocalSource: false };
  }
  if (readClawHubOriginMarker(entry.skill.baseDir)) {
    return { trustSource: "clawhub", untrustedLocalSource: false };
  }
  if (isTrustedSkillDir(entry.skill.baseDir, params.context)) {
    return { trustSource: "trusted-dir", untrustedLocalSource: false };
  }
  if (LOCAL_SKILL_SOURCES.has(params.source)) {
    return {
      trustSource: "local",
      untrustedLocalSource: true,
      trustWarning: UNTRUSTED_LOCAL_SKILL_WARNING,
    };
  }
  return { trustSource: "local", untrustedLocalSource: false };
}

function buildSkillStatus(
  entry: SkillEntry,
  config?: OpenClawConfig,
  prefs?: SkillsInstallPreferences,
  eligibility?: SkillEligibilityContext,
  bundledNames?: Set<string>,
  agentSkillFilter?: string[],
  trustContext: SkillTrustContext = { trustedDirRealPaths: [] },
): SkillStatusEntry {
  const skillKey = resolveSkillKey(entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const allowBundled = resolveBundledAllowlist(config);
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const blockedByAgentFilter =
    agentSkillFilter !== undefined && !agentSkillFilter.includes(entry.skill.name);
  const always = entry.metadata?.always === true;
  const isEnvSatisfied = (envName: string) =>
    Boolean(
      process.env[envName] ||
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
    );
  const isConfigSatisfied = (pathStr: string) => isConfigPathTruthy(config, pathStr);
  const skillSource = resolveSkillSource(entry.skill);
  const bundled =
    skillSource === "openclaw-bundled" ||
    (skillSource === "unknown" && bundledNames?.has(entry.skill.name) === true);
  const trust = resolveSkillTrustStatus(entry, {
    bundled,
    source: skillSource,
    context: trustContext,
  });

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
  const availableToAgent = eligible && !blockedByAgentFilter;
  const userInvocable = isSkillUserInvocable(entry);

  return {
    name: entry.skill.name,
    description: entry.skill.description,
    source: skillSource,
    bundled,
    trustSource: trust.trustSource,
    untrustedLocalSource: trust.untrustedLocalSource,
    trustWarning: trust.trustWarning,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
    skillKey,
    primaryEnv: entry.metadata?.primaryEnv,
    emoji,
    homepage,
    always,
    disabled,
    blockedByAllowlist,
    blockedByAgentFilter,
    eligible,
    modelVisible: availableToAgent && isSkillVisibleInAvailableSkillsPrompt(entry),
    userInvocable,
    commandVisible: availableToAgent && userInvocable,
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
    agentId?: string;
  },
): SkillStatusReport {
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledContext = resolveBundledSkillsContext();
  const agentSkillFilter = opts?.agentId
    ? resolveEffectiveAgentSkillFilter(opts.config, opts.agentId)
    : undefined;
  const skillEntries =
    opts?.entries ??
    loadWorkspaceSkillEntries(workspaceDir, {
      config: opts?.config,
      managedSkillsDir,
      bundledSkillsDir: bundledContext.dir,
    });
  const prefs = resolveSkillsInstallPreferences(opts?.config);
  const trustContext: SkillTrustContext = {
    trustedDirRealPaths: resolveTrustedSkillDirRealPaths(opts?.config),
  };
  return {
    workspaceDir,
    managedSkillsDir,
    agentId: opts?.agentId,
    agentSkillFilter,
    skills: skillEntries.map((entry) =>
      buildSkillStatus(
        entry,
        opts?.config,
        prefs,
        opts?.eligibility,
        bundledContext.names,
        agentSkillFilter,
        trustContext,
      ),
    ),
  };
}
