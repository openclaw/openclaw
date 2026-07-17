import fs from "node:fs";
import path from "node:path";
import {
  REQUIRED_LOCALIZATION_SURFACES,
  requiredChecksForSurface,
  validateLocalizationCoverageManifest,
  type LocalizationContentClass,
  type LocalizationCoverageManifest,
  type LocalizationLocaleState,
  type LocalizationMaturity,
  type LocalizationSurfaceId,
} from "../packages/localization-core/src/coverage.js";
import {
  OPENCLAW_LOCALES,
  OPENCLAW_LOCALE_REGISTRY_REVISION,
  type OpenClawLocale,
} from "../packages/localization-core/src/locale-registry.js";
import { computeLocalizationCatalogRevision } from "./lib/localization-catalog-revision.js";

type SurfaceSeed = {
  owner: string;
  artifactId: string;
  catalogRevision?: "none";
  source: string;
  catalogs?: string;
  contentClasses: readonly LocalizationContentClass[];
  translatedLocales?: readonly OpenClawLocale[];
  completeLocales?: readonly OpenClawLocale[];
  platformConstrainedLocales?: readonly OpenClawLocale[];
  revisionPaths?: readonly string[];
};

const translatedWithoutSwedish = OPENCLAW_LOCALES.filter(
  (locale): locale is Exclude<OpenClawLocale, "en" | "sv"> => locale !== "en" && locale !== "sv",
);
const allTranslationLocales = OPENCLAW_LOCALES.filter(
  (locale): locale is Exclude<OpenClawLocale, "en"> => locale !== "en",
);

const SURFACE_SEEDS: Record<LocalizationSurfaceId, SurfaceSeed> = {
  "control-ui": {
    owner: "control-ui",
    artifactId: "control-ui-web",
    source: "ui/src/i18n/locales/en.ts",
    catalogs: "ui/src/i18n/locales",
    contentClasses: ["general", "authentication", "recovery"],
    translatedLocales: translatedWithoutSwedish,
  },
  "cli-onboarding": {
    owner: "cli",
    artifactId: "openclaw-cli",
    source: "src/wizard/i18n/locales/en.ts",
    catalogs: "src/wizard/i18n/locales",
    contentClasses: ["general", "authentication", "recovery"],
    translatedLocales: ["zh-CN", "zh-TW"],
  },
  "channel-plugin-setup": {
    owner: "channels",
    artifactId: "openclaw-cli",
    source: "src/wizard/i18n/locales/en.ts",
    catalogs: "src/wizard/i18n/locales",
    contentClasses: ["general", "authentication", "recovery"],
    translatedLocales: ["zh-CN", "zh-TW"],
  },
  cli: unmigrated("cli", "openclaw-cli", "src/cli", ["general", "recovery"]),
  tui: unmigrated("tui", "openclaw-cli", "src/tui", ["general", "recovery"]),
  runtime: unmigrated("core-runtime", "openclaw-runtime", "src", [
    "general",
    "safety",
    "security",
    "authentication",
    "authorization",
    "destructive-action",
    "privacy",
    "recovery",
  ]),
  "gateway-errors": unmigrated(
    "gateway",
    "openclaw-gateway",
    "packages/gateway-protocol/src/schema/error-codes.ts",
    ["general", "authentication", "authorization", "recovery"],
  ),
  "server-rendered-channels": unmigrated("channels", "openclaw-runtime", "src/infra", [
    "general",
    "safety",
    "security",
    "recovery",
  ]),
  "command-metadata": unmigrated("command-catalog", "openclaw-runtime", "src/commands", [
    "general",
  ]),
  "telegram-command-menu": unmigrated(
    "telegram",
    "openclaw-plugin-telegram",
    "extensions/telegram",
    ["general"],
  ),
  "discord-command-menu": unmigrated("discord", "openclaw-plugin-discord", "extensions/discord", [
    "general",
  ]),
  "skill-metadata": unmigrated("skills", "openclaw-runtime", "src/agents/skills", ["general"]),
  android: {
    owner: "android",
    artifactId: "openclaw-android",
    source: "apps/.i18n/native-source.json",
    catalogs: "apps/.i18n/native",
    contentClasses: ["general", "safety", "security", "authentication", "recovery", "generated"],
    translatedLocales: allTranslationLocales,
  },
  apple: {
    owner: "apple",
    artifactId: "openclaw-apple",
    source: "apps/.i18n/native-source.json",
    catalogs: "apps/.i18n/native",
    contentClasses: ["general", "safety", "security", "authentication", "recovery", "generated"],
    translatedLocales: allTranslationLocales,
  },
  docs: {
    owner: "docs",
    artifactId: "openclaw-docs",
    source: "docs",
    catalogs: "docs/.i18n",
    revisionPaths: ["docs/.i18n"],
    contentClasses: ["general", "security", "authentication", "recovery", "generated"],
    translatedLocales: translatedWithoutSwedish,
  },
};

const outputPath = path.resolve(import.meta.dirname, "../localization/coverage.json");
const write = process.argv.includes("--write");
const manifest = createManifest();
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (write) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized);
  console.log(`wrote ${path.relative(process.cwd(), outputPath)}`);
} else {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== serialized) {
    console.error("localization coverage manifest is stale; run pnpm localization:coverage:sync");
    process.exitCode = 1;
  }
}

function createManifest(): LocalizationCoverageManifest {
  const surfaces = Object.fromEntries(
    REQUIRED_LOCALIZATION_SURFACES.map((surfaceId) => {
      const seed = SURFACE_SEEDS[surfaceId];
      const locales = createLocaleRows(seed);
      const surface = {
        owner: seed.owner,
        artifactId: seed.artifactId,
        catalogRevision: catalogRevision(seed),
        source: seed.source,
        ...(seed.catalogs ? { catalogs: seed.catalogs } : {}),
        contentClasses: seed.contentClasses,
        checks: requiredChecksForSurface({ contentClasses: seed.contentClasses, locales }),
        locales,
      };
      return [surfaceId, surface];
    }),
  ) as LocalizationCoverageManifest["surfaces"];

  const generatedManifest: LocalizationCoverageManifest = {
    version: 1,
    localeRegistry: "packages/localization-core/src/locale-registry.ts",
    registryRevision: OPENCLAW_LOCALE_REGISTRY_REVISION,
    testFixtures: {
      "pseudo-expanded": { kind: "expansion", direction: "ltr" },
      "pseudo-bidi": { kind: "bidirectional", direction: "rtl" },
      "he-rtl": { kind: "bidirectional", direction: "rtl", languageTag: "he" },
      "bn-indic": { kind: "shaping", direction: "ltr", languageTag: "bn" },
      "km-segmentation": { kind: "segmentation", direction: "ltr", languageTag: "km" },
      "am-ethiopic": { kind: "shaping", direction: "ltr", languageTag: "am" },
    },
    surfaces,
  };
  const issues = validateLocalizationCoverageManifest(generatedManifest);
  if (issues.length > 0) {
    throw new Error(issues.map((entry) => `${entry.path}: ${entry.detail}`).join("\n"));
  }
  return generatedManifest;
}

function createLocaleRows(seed: SurfaceSeed): Record<OpenClawLocale, LocalizationLocaleState> {
  return Object.fromEntries(
    OPENCLAW_LOCALES.map((locale) => {
      const maturity = maturityForLocale(seed, locale);
      return [
        locale,
        {
          maturity,
          ...(maturity === "complete" ? { languageOwner: "openclaw-localization" } : {}),
        },
      ];
    }),
  ) as Record<OpenClawLocale, LocalizationLocaleState>;
}

function maturityForLocale(seed: SurfaceSeed, locale: OpenClawLocale): LocalizationMaturity {
  if (locale === "en") {
    return "source";
  }
  if (seed.completeLocales?.includes(locale)) {
    return "complete";
  }
  if (seed.platformConstrainedLocales?.includes(locale)) {
    return "platform-constrained";
  }
  if (seed.translatedLocales?.includes(locale)) {
    return "partial";
  }
  return "unsupported";
}

function unmigrated(
  owner: string,
  artifactId: string,
  source: string,
  contentClasses: readonly LocalizationContentClass[],
): SurfaceSeed {
  return {
    owner,
    artifactId,
    catalogRevision: "none",
    source,
    contentClasses,
  };
}

function catalogRevision(seed: SurfaceSeed): string {
  if (seed.catalogRevision === "none") {
    return "none";
  }
  return computeLocalizationCatalogRevision(
    path.resolve(import.meta.dirname, ".."),
    seed.revisionPaths ??
      [seed.source, seed.catalogs].filter((value): value is string => Boolean(value)),
  );
}
