import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CATALOGS = [
  path.join(ROOT, "apps", "ios", "Resources", "Localizable.xcstrings"),
  path.join(ROOT, "apps", "macos", "Sources", "OpenClaw", "Resources", "Localizable.xcstrings"),
];

type Catalog = {
  sourceLanguage?: string;
  strings?: Record<
    string,
    {
      localizations?: Record<string, { stringUnit?: { value?: string } }>;
    }
  >;
};

export async function checkAppleAppI18n() {
  let checked = 0;
  for (const catalogPath of CATALOGS) {
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
    if (catalog.sourceLanguage !== "en" || !catalog.strings) {
      throw new Error(`invalid Apple string catalog: ${path.relative(ROOT, catalogPath)}`);
    }
    for (const [key, entry] of Object.entries(catalog.strings)) {
      for (const locale of ["en", "ru", "hi"]) {
        const value = entry.localizations?.[locale]?.stringUnit?.value?.trim();
        if (!value) {
          throw new Error(
            `Apple catalog ${path.relative(ROOT, catalogPath)} is missing ${locale} for ${JSON.stringify(key)}`,
          );
        }
      }
      checked += 1;
    }
  }
  process.stdout.write(
    `apple-app-i18n: catalogs=${CATALOGS.length} keys=${checked} locales=ru,hi\n`,
  );
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const [command] = process.argv.slice(2);
  if (command !== "check") {
    throw new Error("usage: node --import tsx scripts/apple-app-i18n.ts check");
  }
  await checkAppleAppI18n();
}
