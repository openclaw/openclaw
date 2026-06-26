import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_I18N_LOCALES } from "./native-app-i18n.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RESOURCE_ROOT = path.join(ROOT, "apps", "android", "app", "src", "main", "res");
const ANDROID_QUALIFIERS: Record<string, string> = {
  "zh-CN": "zh-rCN",
  "zh-TW": "zh-rTW",
  "pt-BR": "pt-rBR",
  "ja-JP": "ja",
};
const localeDirectory = (locale: string) => `values-${ANDROID_QUALIFIERS[locale] ?? locale}`;
const LOCALES = ["values", ...NATIVE_I18N_LOCALES.map(localeDirectory)] as const;
const KEY_RE = /<string\s+name="([A-Za-z0-9_]+)"[^>]*>/gu;

async function readKeys(locale: string): Promise<Set<string>> {
  const source = await readFile(path.join(RESOURCE_ROOT, locale, "strings.xml"), "utf8");
  return new Set([...source.matchAll(KEY_RE)].map((match) => match[1]).filter(Boolean));
}

export async function checkAndroidAppI18n() {
  const [base, ...translations] = await Promise.all(LOCALES.map(readKeys));
  const problems = translations.flatMap((keys, index) => {
    const locale = NATIVE_I18N_LOCALES[index];
    return [
      [`${locale} missing`, [...base].filter((key) => !keys.has(key))],
      [`${locale} extra`, [...keys].filter((key) => !base.has(key))],
    ] as const;
  });
  if (problems.some(([, keys]) => keys.length)) {
    throw new Error(
      [
        "Android app i18n resources are out of sync.",
        ...problems.map(([label, keys]) => `${label}=${keys.join(",") || "none"}`),
      ].join("\n"),
    );
  }
  process.stdout.write(
    `android-app-i18n: keys=${base.size} locales=${NATIVE_I18N_LOCALES.join(",")}\n`,
  );
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const [command] = process.argv.slice(2);
  if (command !== "check") {
    throw new Error("usage: node --import tsx scripts/android-app-i18n.ts check");
  }
  await checkAndroidAppI18n();
}
