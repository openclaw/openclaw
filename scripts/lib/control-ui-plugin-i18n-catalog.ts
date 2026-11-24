import { existsSync, lstatSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { controlUiSource } from "../../src/plugins/package-manifest.ts";
import { collectSourceCheckoutPluginBuildEntries } from "./bundled-plugin-build-entries.mjs";
import {
  materializeControlUiLocaleCatalog,
  mergeControlUiTranslationMaps,
  setControlUiCatalogValue,
} from "./control-ui-i18n-catalog-values.ts";
import {
  flattenTranslations,
  type TranslationMap,
  type TranslationMemoryEntry,
} from "./control-ui-i18n-sync-plan.ts";

/** Authoring inputs stay separate from the core catalog consumed by Vite. */
export async function loadControlUiPluginCatalogs(repoRoot: string) {
  const catalogs: Array<{
    id: string;
    browserRoot: string;
    source: unknown;
    translations: Record<string, unknown>;
  }> = [];
  // Translation ownership covers source packages, including separately distributed plugins,
  // regardless of the caller's selected Docker/build subset.
  const plugins = collectSourceCheckoutPluginBuildEntries({ cwd: repoRoot, env: {} });
  for (const plugin of plugins) {
    const entry = isRecord(plugin.packageJson) && controlUiSource(plugin.packageJson);
    if (!entry) {
      continue;
    }
    const pluginRoot = await realpath(path.join(repoRoot, "extensions", plugin.id));
    const browserRoot = path.dirname(
      await resolveCatalogFile(pluginRoot, path.resolve(pluginRoot, entry)),
    );
    const localesRoot = path.join(browserRoot, "i18n/locales");
    const sourcePath = path.join(localesRoot, "en.ts");
    if (!existsSync(sourcePath)) {
      continue;
    }
    const sourceFile = await resolveCatalogFile(pluginRoot, sourcePath);
    // Sync now writes here. Qualify existing directory/file links under the same
    // plugin boundary as read inputs before a locale worker can follow them.
    const assetsRoot = path.join(browserRoot, "i18n/.i18n");
    if (existsSync(assetsRoot)) {
      await resolveCatalogFile(pluginRoot, assetsRoot);
      for (const file of await readdir(assetsRoot)) {
        if (file.endsWith(".tm.jsonl") || file.endsWith(".meta.json")) {
          await resolveCatalogFile(pluginRoot, path.join(assetsRoot, file));
        }
      }
    }
    const translationsPath = path.join(localesRoot, "translated.json");
    // A dangling link is not an absent catalog: aggregate writes would follow
    // it outside the plugin. Keep it subject to realpath validation below.
    const translations: unknown = lstatSync(translationsPath, { throwIfNoEntry: false })
      ? JSON.parse(await readFile(await resolveCatalogFile(pluginRoot, translationsPath), "utf8"))
      : {};
    if (!isRecord(translations)) {
      throw new Error(`${plugin.id}: translated.json must contain locale catalogs`);
    }
    const source: unknown = (await import(pathToFileURL(sourceFile).href)).default;
    catalogs.push({
      id: plugin.id,
      browserRoot: path.relative(repoRoot, browserRoot).split(path.sep).join("/"),
      source,
      translations,
    });
  }
  return catalogs;
}

/** The aggregate writer fills absent keys only; locale workers own disjoint memory files. */
export function materializeControlUiPluginTranslations(
  sourceFlat: ReadonlyMap<string, string>,
  authored: Readonly<Record<string, TranslationMap>>,
  memories: ReadonlyMap<string, ReadonlyMap<string, TranslationMemoryEntry>>,
) {
  const translations = { ...authored };
  const missing: string[] = [];
  let added = 0;
  for (const [locale, memory] of memories) {
    const catalog = mergeControlUiTranslationMaps(authored[locale] ?? {});
    const authoredFlat = flattenTranslations(catalog);
    const materialized = flattenTranslations(materializeControlUiLocaleCatalog(sourceFlat, memory));
    for (const key of sourceFlat.keys()) {
      if (authoredFlat.has(key)) {
        continue;
      }
      const value = materialized.get(key);
      if (value === undefined) {
        missing.push(`${locale}:${key}`);
        continue;
      }
      // A historical string ancestor cannot become an object without losing authored copy.
      const parts = key.split(".");
      for (let length = 1; length < parts.length; length += 1) {
        if (authoredFlat.has(parts.slice(0, length).join("."))) {
          throw new Error(`${locale}:${key} would overwrite an authored translation`);
        }
      }
      setControlUiCatalogValue(catalog, key, value);
      added += 1;
    }
    translations[locale] = catalog;
  }
  return { added, missing, translations };
}

async function resolveCatalogFile(pluginRoot: string, filePath: string) {
  const file = await realpath(filePath);
  const relative = path.relative(pluginRoot, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Control UI locale sources must stay inside the plugin package.");
  }
  return file;
}
