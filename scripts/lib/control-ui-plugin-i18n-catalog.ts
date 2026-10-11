import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { controlUiSource } from "../../src/plugins/package-manifest.ts";
import { collectSourceCheckoutPluginBuildEntries } from "./bundled-plugin-build-entries.mjs";

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
    const entry = plugin.packageJson && controlUiSource(plugin.packageJson);
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
    const translationsPath = path.join(localesRoot, "translated.json");
    const translations: unknown = existsSync(translationsPath)
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

async function resolveCatalogFile(pluginRoot: string, filePath: string) {
  const file = await realpath(filePath);
  const relative = path.relative(pluginRoot, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Control UI locale sources must stay inside the plugin package.");
  }
  return file;
}
