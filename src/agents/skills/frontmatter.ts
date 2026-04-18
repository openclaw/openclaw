import { validateRegistryNpmSpec } from "../../infra/npm-registry-spec.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import {
  applyOpenClawManifestInstallCommonFields,
  getFrontmatterString,
  normalizeStringList,
  parseOpenClawManifestInstallBase,
  parseFrontmatterBool,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestInstall,
  resolveOpenClawManifestOs,
  resolveOpenClawManifestRequires,
} from "../../shared/frontmatter.js";
import { readStringValue } from "../../shared/string-coerce.js";
import type { Skill } from "./skill-contract.js";
import type {
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEntry,
  SkillInstallSpec,
  SkillInvocationPolicy,
  SkillPlanTemplateStep,
} from "./types.js";

export function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  return parseFrontmatterBlock(content);
}

const BREW_FORMULA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@+._/-]*$/;
const GO_MODULE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~+\-/]*(?:@[A-Za-z0-9][A-Za-z0-9._~+\-/]*)?$/;
const UV_PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-[\]=<>!~+,]*$/;

function normalizeSafeBrewFormula(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const formula = raw.trim();
  if (!formula || formula.startsWith("-") || formula.includes("\\") || formula.includes("..")) {
    return undefined;
  }
  if (!BREW_FORMULA_PATTERN.test(formula)) {
    return undefined;
  }
  return formula;
}

function normalizeSafeNpmSpec(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const spec = raw.trim();
  if (!spec || spec.startsWith("-")) {
    return undefined;
  }
  if (validateRegistryNpmSpec(spec) !== null) {
    return undefined;
  }
  return spec;
}

function normalizeSafeGoModule(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const moduleSpec = raw.trim();
  if (
    !moduleSpec ||
    moduleSpec.startsWith("-") ||
    moduleSpec.includes("\\") ||
    moduleSpec.includes("://")
  ) {
    return undefined;
  }
  if (!GO_MODULE_PATTERN.test(moduleSpec)) {
    return undefined;
  }
  return moduleSpec;
}

function normalizeSafeUvPackage(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const pkg = raw.trim();
  if (!pkg || pkg.startsWith("-") || pkg.includes("\\") || pkg.includes("://")) {
    return undefined;
  }
  if (!UV_PACKAGE_PATTERN.test(pkg)) {
    return undefined;
  }
  return pkg;
}

function normalizeSafeDownloadUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  if (!value || /\s/.test(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  const parsed = parseOpenClawManifestInstallBase(input, ["brew", "node", "go", "uv", "download"]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec = applyOpenClawManifestInstallCommonFields<SkillInstallSpec>(
    {
      kind: parsed.kind as SkillInstallSpec["kind"],
    },
    parsed,
  );
  const osList = normalizeStringList(raw.os);
  if (osList.length > 0) {
    spec.os = osList;
  }
  const formula = normalizeSafeBrewFormula(raw.formula);
  if (formula) {
    spec.formula = formula;
  }
  const cask = normalizeSafeBrewFormula(raw.cask);
  if (!spec.formula && cask) {
    spec.formula = cask;
  }
  if (spec.kind === "node") {
    const pkg = normalizeSafeNpmSpec(raw.package);
    if (pkg) {
      spec.package = pkg;
    }
  } else if (spec.kind === "uv") {
    const pkg = normalizeSafeUvPackage(raw.package);
    if (pkg) {
      spec.package = pkg;
    }
  }
  const moduleSpec = normalizeSafeGoModule(raw.module);
  if (moduleSpec) {
    spec.module = moduleSpec;
  }
  const downloadUrl = normalizeSafeDownloadUrl(raw.url);
  if (downloadUrl) {
    spec.url = downloadUrl;
  }
  if (typeof raw.archive === "string") {
    spec.archive = raw.archive;
  }
  if (typeof raw.extract === "boolean") {
    spec.extract = raw.extract;
  }
  if (typeof raw.stripComponents === "number") {
    spec.stripComponents = raw.stripComponents;
  }
  if (typeof raw.targetDir === "string") {
    spec.targetDir = raw.targetDir;
  }

  if (spec.kind === "brew" && !spec.formula) {
    return undefined;
  }
  if (spec.kind === "node" && !spec.package) {
    return undefined;
  }
  if (spec.kind === "go" && !spec.module) {
    return undefined;
  }
  if (spec.kind === "uv" && !spec.package) {
    return undefined;
  }
  if (spec.kind === "download" && !spec.url) {
    return undefined;
  }

  return spec;
}

function parsePlanTemplate(raw: unknown): SkillPlanTemplateStep[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const parsed: SkillPlanTemplateStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    // Strict type guard: `step` must be a non-empty string after trim.
    // Reject non-string steps (objects, arrays, numbers, booleans) instead
    // of coercing them via String() — coercion produces useless output
    // like "[object Object]" that the agent can't act on.
    //
    // PR-E review fix (Copilot #3096524315 / #3105043896): also accept
    // `content` as an alias for `step`. The PR description's example used
    // `content:` which would have silently parsed as empty otherwise.
    // `step` wins on conflict — it matches the canonical field name in
    // `SkillPlanTemplateStep` and downstream `update_plan` schema.
    const stepRaw =
      typeof record.step === "string"
        ? record.step
        : typeof record.content === "string"
          ? record.content
          : undefined;
    if (stepRaw === undefined) {
      continue;
    }
    const step = stepRaw.trim();
    if (step.length === 0) {
      continue;
    }
    // Trim-before-truthy on activeForm: an entry like
    // `activeForm: "   "` should be treated as missing, not as a
    // whitespace-only display string.
    let activeForm: string | undefined;
    if (typeof record.activeForm === "string") {
      const trimmed = record.activeForm.trim();
      if (trimmed.length > 0) {
        activeForm = trimmed;
      }
    }
    parsed.push(activeForm !== undefined ? { step, activeForm } : { step });
  }
  return parsed;
}

export function resolveOpenClawMetadata(
  frontmatter: ParsedSkillFrontmatter,
): OpenClawSkillMetadata | undefined {
  const metadataObj = resolveOpenClawManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveOpenClawManifestRequires(metadataObj);
  const install = resolveOpenClawManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveOpenClawManifestOs(metadataObj);
  // Accept both kebab-case (`plan-template`) and camelCase (`planTemplate`)
  // frontmatter keys. Codex P1 (PR #67541 r3096435164) — natural authors
  // following the `primaryEnv`/`skillKey` camelCase convention would have
  // their templates silently ignored otherwise. Kebab-case wins on conflict
  // for backward compatibility with existing skills.
  //
  // PR-E review fix (Copilot #3105043876): if kebab-case key is PRESENT
  // but parses to an empty array (invalid shape — string, object,
  // entries with non-string `step`, etc.), fall back to camelCase
  // instead of returning empty. The prior `??` only fell through on
  // null/undefined, so a malformed kebab-case key would silently
  // shadow a valid camelCase template.
  const kebabParsed = parsePlanTemplate(metadataObj["plan-template"]);
  const camelParsed = parsePlanTemplate(metadataObj.planTemplate);
  const planTemplate = kebabParsed.length > 0 ? kebabParsed : camelParsed;
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: readStringValue(metadataObj.emoji),
    homepage: readStringValue(metadataObj.homepage),
    skillKey: readStringValue(metadataObj.skillKey),
    primaryEnv: readStringValue(metadataObj.primaryEnv),
    os: osRaw.length > 0 ? osRaw : undefined,
    requires: requires,
    install: install.length > 0 ? install : undefined,
    planTemplate: planTemplate.length > 0 ? planTemplate : undefined,
  };
}

export function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(getFrontmatterString(frontmatter, "user-invocable"), true),
    disableModelInvocation: parseFrontmatterBool(
      getFrontmatterString(frontmatter, "disable-model-invocation"),
      false,
    ),
  };
}

export function resolveSkillKey(skill: Skill, entry?: SkillEntry): string {
  return entry?.metadata?.skillKey ?? skill.name;
}
