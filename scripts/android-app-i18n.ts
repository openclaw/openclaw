import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RESOURCE_ROOT = path.join(ROOT, "apps", "android", "app", "src", "main", "res");
const LOCALES = ["values", "values-ru", "values-hi"] as const;
const KEY_RE = /<string\s+name="([A-Za-z0-9_]+)"[^>]*>/gu;

async function readKeys(locale: string): Promise<Set<string>> {
  const source = await readFile(path.join(RESOURCE_ROOT, locale, "strings.xml"), "utf8");
  return new Set([...source.matchAll(KEY_RE)].map((match) => match[1]).filter(Boolean));
}

export async function checkAndroidAppI18n() {
  const [base, russian, hindi] = await Promise.all(LOCALES.map(readKeys));
  const missing = {
    hi: [...base].filter((key) => !hindi.has(key)),
    ru: [...base].filter((key) => !russian.has(key)),
  };
  const extra = {
    hi: [...hindi].filter((key) => !base.has(key)),
    ru: [...russian].filter((key) => !base.has(key)),
  };
  if (missing.hi.length || missing.ru.length || extra.hi.length || extra.ru.length) {
    throw new Error(
      [
        "Android app i18n resources are out of sync.",
        `ru missing=${missing.ru.join(",") || "none"} extra=${extra.ru.join(",") || "none"}`,
        `hi missing=${missing.hi.join(",") || "none"} extra=${extra.hi.join(",") || "none"}`,
      ].join("\n"),
    );
  }
  process.stdout.write(`android-app-i18n: keys=${base.size} locales=ru,hi\n`);
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const [command] = process.argv.slice(2);
  if (command !== "check") {
    throw new Error("usage: node --import tsx scripts/android-app-i18n.ts check");
  }
  await checkAndroidAppI18n();
}
