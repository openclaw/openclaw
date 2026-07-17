import {
  OPENCLAW_LOCALES,
  OPENCLAW_LOCALE_REGISTRY_REVISION,
  type LocaleDirection,
  type OpenClawLocale,
} from "./locale-registry.js";

export const LOCALIZATION_MATURITY_STATES = [
  "source",
  "complete",
  "partial",
  "experimental",
  "platform-constrained",
  "unsupported",
] as const;

export type LocalizationMaturity = (typeof LOCALIZATION_MATURITY_STATES)[number];

export const LOCALIZATION_CONTENT_CLASSES = [
  "general",
  "safety",
  "security",
  "authentication",
  "authorization",
  "destructive-action",
  "privacy",
  "recovery",
  "generated",
] as const;

export type LocalizationContentClass = (typeof LOCALIZATION_CONTENT_CLASSES)[number];

export const LOCALIZATION_CHECKS = [
  "key-parity",
  "placeholder-parity",
  "fallback-reporting",
  "namespace-ownership",
  "locale-state-isolation",
  "hardcoded-string-inventory",
  "generated-artifact-parity",
  "human-review-attestation",
] as const;

export type LocalizationCheck = (typeof LOCALIZATION_CHECKS)[number];

export const REQUIRED_LOCALIZATION_SURFACES = [
  "control-ui",
  "cli-onboarding",
  "channel-plugin-setup",
  "cli",
  "tui",
  "runtime",
  "gateway-errors",
  "server-rendered-channels",
  "command-metadata",
  "telegram-command-menu",
  "discord-command-menu",
  "skill-metadata",
  "android",
  "apple",
  "docs",
] as const;

export type LocalizationSurfaceId = (typeof REQUIRED_LOCALIZATION_SURFACES)[number];

export type LocalizationLocaleState = {
  maturity: LocalizationMaturity;
  languageOwner?: string;
};

export type LocalizationCoverageSurface = {
  owner: string;
  artifactId: string;
  catalogRevision: string;
  source: string;
  catalogs?: string;
  contentClasses: readonly LocalizationContentClass[];
  checks: readonly LocalizationCheck[];
  locales: Readonly<Record<OpenClawLocale, LocalizationLocaleState>>;
};

export type LocalizationTestFixture = {
  kind: "expansion" | "bidirectional" | "shaping" | "segmentation";
  direction: LocaleDirection;
  languageTag?: string;
};

export type LocalizationCoverageManifest = {
  version: 1;
  localeRegistry: string;
  registryRevision: string;
  testFixtures: Readonly<Record<string, LocalizationTestFixture>>;
  surfaces: Readonly<Record<LocalizationSurfaceId, LocalizationCoverageSurface>>;
};

export type LocalizationCoverageIssue = {
  path: string;
  detail: string;
};

const MATURITY_STATES = new Set<string>(LOCALIZATION_MATURITY_STATES);
const CONTENT_CLASSES = new Set<string>(LOCALIZATION_CONTENT_CLASSES);
const CHECKS = new Set<string>(LOCALIZATION_CHECKS);
const SENSITIVE_CONTENT_CLASSES = new Set<LocalizationContentClass>([
  "safety",
  "security",
  "authentication",
  "authorization",
  "destructive-action",
  "privacy",
  "recovery",
]);
const BASE_COMPLETE_CHECKS: readonly LocalizationCheck[] = [
  "key-parity",
  "placeholder-parity",
  "fallback-reporting",
  "namespace-ownership",
  "locale-state-isolation",
  "hardcoded-string-inventory",
];

export function validateLocalizationCoverageManifest(
  value: unknown,
): readonly LocalizationCoverageIssue[] {
  const issues: LocalizationCoverageIssue[] = [];
  if (!isRecord(value)) {
    return [issue("$", "Manifest must be an object.")];
  }

  if (value.version !== 1) {
    issues.push(issue("version", "Version must be 1."));
  }
  if (value.registryRevision !== OPENCLAW_LOCALE_REGISTRY_REVISION) {
    issues.push(
      issue(
        "registryRevision",
        `Expected locale registry revision ${OPENCLAW_LOCALE_REGISTRY_REVISION}.`,
      ),
    );
  }
  if (typeof value.localeRegistry !== "string" || !value.localeRegistry.trim()) {
    issues.push(issue("localeRegistry", "Locale registry path is required."));
  }

  validateFixtures(value.testFixtures, issues);
  validateSurfaces(value.surfaces, issues);
  return Object.freeze(issues.map((entry) => Object.freeze(entry)));
}

export function requiredChecksForSurface(
  surface: Pick<LocalizationCoverageSurface, "contentClasses" | "locales">,
): readonly LocalizationCheck[] {
  const hasCompleteLocale = Object.values(
    surface.locales as Readonly<Record<string, unknown>>,
  ).some((state) => isRecord(state) && state.maturity === "complete");
  if (!hasCompleteLocale) {
    return [];
  }
  const required = new Set<LocalizationCheck>(BASE_COMPLETE_CHECKS);
  if (surface.contentClasses.includes("generated")) {
    required.add("generated-artifact-parity");
  }
  if (surface.contentClasses.some((contentClass) => SENSITIVE_CONTENT_CLASSES.has(contentClass))) {
    required.add("human-review-attestation");
  }
  return [...required].toSorted();
}

function validateFixtures(value: unknown, issues: LocalizationCoverageIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("testFixtures", "Test fixtures must be an object."));
    return;
  }
  for (const [fixtureId, fixture] of Object.entries(value)) {
    const path = `testFixtures.${fixtureId}`;
    if (OPENCLAW_LOCALES.includes(fixtureId as OpenClawLocale)) {
      issues.push(issue(path, "Release locale IDs cannot be reused as test fixture IDs."));
    }
    if (!isRecord(fixture)) {
      issues.push(issue(path, "Fixture must be an object."));
      continue;
    }
    if (!["expansion", "bidirectional", "shaping", "segmentation"].includes(String(fixture.kind))) {
      issues.push(issue(`${path}.kind`, "Unknown fixture kind."));
    }
    if (fixture.direction !== "ltr" && fixture.direction !== "rtl") {
      issues.push(issue(`${path}.direction`, "Direction must be ltr or rtl."));
    }
  }
}

function validateSurfaces(value: unknown, issues: LocalizationCoverageIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("surfaces", "Surfaces must be an object."));
    return;
  }

  for (const surfaceId of REQUIRED_LOCALIZATION_SURFACES) {
    const surface = value[surfaceId];
    const path = `surfaces.${surfaceId}`;
    if (!isRecord(surface)) {
      issues.push(issue(path, "Required surface is missing."));
      continue;
    }
    validateSurface(path, surface, issues);
  }

  for (const surfaceId of Object.keys(value)) {
    if (!REQUIRED_LOCALIZATION_SURFACES.includes(surfaceId as LocalizationSurfaceId)) {
      issues.push(issue(`surfaces.${surfaceId}`, "Unknown localization surface."));
    }
  }
}

function validateSurface(
  path: string,
  surface: Record<string, unknown>,
  issues: LocalizationCoverageIssue[],
): void {
  for (const field of ["owner", "artifactId", "catalogRevision", "source"] as const) {
    if (typeof surface[field] !== "string" || !surface[field].trim()) {
      issues.push(issue(`${path}.${field}`, `${field} is required.`));
    }
  }

  const contentClasses = validateStringSet(
    `${path}.contentClasses`,
    surface.contentClasses,
    CONTENT_CLASSES,
    issues,
  ) as LocalizationContentClass[];
  const checks = validateStringSet(`${path}.checks`, surface.checks, CHECKS, issues);
  const locales = surface.locales;
  if (!isRecord(locales)) {
    issues.push(issue(`${path}.locales`, "Locale rows must be an object."));
    return;
  }

  for (const locale of OPENCLAW_LOCALES) {
    const state = locales[locale];
    const statePath = `${path}.locales.${locale}`;
    if (!isRecord(state)) {
      issues.push(issue(statePath, "Required locale row is missing."));
      continue;
    }
    if (!MATURITY_STATES.has(String(state.maturity))) {
      issues.push(issue(`${statePath}.maturity`, "Unknown maturity state."));
      continue;
    }
    if (locale === "en" && state.maturity !== "source") {
      issues.push(issue(`${statePath}.maturity`, "English must be the source locale."));
    }
    if (locale !== "en" && state.maturity === "source") {
      issues.push(issue(`${statePath}.maturity`, "Only English can be the source locale."));
    }
    if (
      state.maturity === "complete" &&
      (typeof state.languageOwner !== "string" || !state.languageOwner.trim())
    ) {
      issues.push(issue(`${statePath}.languageOwner`, "Complete translations require an owner."));
    }
  }

  for (const locale of Object.keys(locales)) {
    if (!OPENCLAW_LOCALES.includes(locale as OpenClawLocale)) {
      issues.push(issue(`${path}.locales.${locale}`, "Unknown release locale."));
    }
  }

  if (contentClasses.length > 0) {
    const required = requiredChecksForSurface({
      contentClasses,
      locales: locales as Record<OpenClawLocale, LocalizationLocaleState>,
    });
    for (const check of required) {
      if (!checks.includes(check)) {
        issues.push(issue(`${path}.checks`, `Missing derived check: ${check}.`));
      }
    }
  }
}

function validateStringSet(
  path: string,
  value: unknown,
  allowed: ReadonlySet<string>,
  issues: LocalizationCoverageIssue[],
): string[] {
  if (!Array.isArray(value)) {
    issues.push(issue(path, "Expected an array."));
    return [];
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  if (strings.length !== value.length || new Set(strings).size !== strings.length) {
    issues.push(issue(path, "Entries must be unique strings."));
  }
  for (const entry of strings) {
    if (!allowed.has(entry)) {
      issues.push(issue(path, `Unknown value: ${entry}.`));
    }
  }
  return strings;
}

function issue(path: string, detail: string): LocalizationCoverageIssue {
  return { path, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
