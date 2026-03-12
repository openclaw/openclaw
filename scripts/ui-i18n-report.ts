import { parseArgs } from "node:util";
import type { Locale, TranslationMap } from "../ui/src/i18n/lib/types.ts";
import { de } from "../ui/src/i18n/locales/de.ts";
import { en } from "../ui/src/i18n/locales/en.ts";
import { es } from "../ui/src/i18n/locales/es.ts";
import { pt_BR } from "../ui/src/i18n/locales/pt-BR.ts";
import { zh_CN } from "../ui/src/i18n/locales/zh-CN.ts";
import { zh_TW } from "../ui/src/i18n/locales/zh-TW.ts";

type LocaleRegistry = Record<Locale, TranslationMap>;

const LOCALES: LocaleRegistry = {
  en,
  "zh-CN": zh_CN,
  "zh-TW": zh_TW,
  "pt-BR": pt_BR,
  de,
  es,
};

type Report = {
  locale: Locale;
  translated: number;
  total: number;
  missing: string[];
  extra: string[];
};

function flattenTranslationKeys(map: TranslationMap, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      keys.push(next);
      continue;
    }
    keys.push(...flattenTranslationKeys(value, next));
  }
  return keys;
}

function buildReport(locale: Locale): Report {
  const source = new Set(flattenTranslationKeys(LOCALES.en));
  const target = new Set(flattenTranslationKeys(LOCALES[locale]));
  const missing = [...source].filter((key) => !target.has(key)).toSorted();
  const extra = [...target].filter((key) => !source.has(key)).toSorted();
  const translated = source.size - missing.length;
  return {
    locale,
    translated,
    total: source.size,
    missing,
    extra,
  };
}

function formatCoverage(translated: number, total: number): string {
  if (total === 0) {
    return "0.0";
  }
  return ((translated / total) * 100).toFixed(1);
}

function parseLocaleValues(raw: string[]): Locale[] {
  const supported = new Set<Locale>(Object.keys(LOCALES) as Locale[]);
  const locales: Locale[] = [];
  for (const entry of raw) {
    if (!supported.has(entry as Locale)) {
      console.error(
        `Unsupported locale "${entry}". Supported locales: ${[...supported].join(", ")}`,
      );
      process.exit(1);
    }
    locales.push(entry as Locale);
  }
  return locales;
}

function printReport(report: Report) {
  const coverage = formatCoverage(report.translated, report.total);
  console.log(
    `${report.locale}: ${report.translated}/${report.total} (${coverage}%) translated, missing=${report.missing.length}, extra=${report.extra.length}`,
  );
  if (report.missing.length > 0) {
    console.log("  Missing keys:");
    report.missing.forEach((key) => console.log(`    - ${key}`));
  }
  if (report.extra.length > 0) {
    console.log("  Extra keys:");
    report.extra.forEach((key) => console.log(`    - ${key}`));
  }
}

const args = parseArgs({
  options: {
    locale: {
      type: "string",
      multiple: true,
    },
    strict: {
      type: "boolean",
      default: false,
    },
  },
  allowPositionals: false,
});

const selectedLocales =
  args.values.locale && args.values.locale.length > 0
    ? parseLocaleValues(args.values.locale)
    : (Object.keys(LOCALES) as Locale[]).filter((locale) => locale !== "en");

const reports = selectedLocales.map(buildReport);
for (const report of reports) {
  printReport(report);
}

const hasProblems = reports.some((report) => report.missing.length > 0 || report.extra.length > 0);
if (args.values.strict && hasProblems) {
  process.exit(1);
}
