import { LocaleDirection, OpenClawLocale } from "./locale-registry.mjs";

//#region src/coverage.d.ts
declare const LOCALIZATION_MATURITY_STATES: readonly ["source", "complete", "partial", "experimental", "platform-constrained", "unsupported"];
type LocalizationMaturity = (typeof LOCALIZATION_MATURITY_STATES)[number];
declare const LOCALIZATION_CONTENT_CLASSES: readonly ["general", "safety", "security", "authentication", "authorization", "destructive-action", "privacy", "recovery", "generated"];
type LocalizationContentClass = (typeof LOCALIZATION_CONTENT_CLASSES)[number];
declare const LOCALIZATION_CHECKS: readonly ["key-parity", "placeholder-parity", "fallback-reporting", "namespace-ownership", "locale-state-isolation", "hardcoded-string-inventory", "generated-artifact-parity", "human-review-attestation"];
type LocalizationCheck = (typeof LOCALIZATION_CHECKS)[number];
declare const REQUIRED_LOCALIZATION_SURFACES: readonly ["control-ui", "cli-onboarding", "channel-plugin-setup", "cli", "tui", "runtime", "gateway-errors", "server-rendered-channels", "command-metadata", "telegram-command-menu", "discord-command-menu", "skill-metadata", "android", "apple", "docs"];
type LocalizationSurfaceId = (typeof REQUIRED_LOCALIZATION_SURFACES)[number];
type LocalizationLocaleState = {
  maturity: LocalizationMaturity;
  languageOwner?: string;
};
type LocalizationCoverageSurface = {
  owner: string;
  artifactId: string;
  catalogRevision: string;
  source: string;
  catalogs?: string;
  contentClasses: readonly LocalizationContentClass[];
  checks: readonly LocalizationCheck[];
  locales: Readonly<Record<OpenClawLocale, LocalizationLocaleState>>;
};
type LocalizationTestFixture = {
  kind: "expansion" | "bidirectional" | "shaping" | "segmentation";
  direction: LocaleDirection;
  languageTag?: string;
};
type LocalizationCoverageManifest = {
  version: 1;
  localeRegistry: string;
  registryRevision: string;
  testFixtures: Readonly<Record<string, LocalizationTestFixture>>;
  surfaces: Readonly<Record<LocalizationSurfaceId, LocalizationCoverageSurface>>;
};
type LocalizationCoverageIssue = {
  path: string;
  detail: string;
};
declare function validateLocalizationCoverageManifest(value: unknown): readonly LocalizationCoverageIssue[];
declare function requiredChecksForSurface(surface: Pick<LocalizationCoverageSurface, "contentClasses" | "locales">): readonly LocalizationCheck[];
//#endregion
export { LOCALIZATION_CHECKS, LOCALIZATION_CONTENT_CLASSES, LOCALIZATION_MATURITY_STATES, LocalizationCheck, LocalizationContentClass, LocalizationCoverageIssue, LocalizationCoverageManifest, LocalizationCoverageSurface, LocalizationLocaleState, LocalizationMaturity, LocalizationSurfaceId, LocalizationTestFixture, REQUIRED_LOCALIZATION_SURFACES, requiredChecksForSurface, validateLocalizationCoverageManifest };