import fs from "node:fs";
import path from "node:path";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../../src/plugins/official-external-plugin-catalog.ts";
import { NON_PACKAGED_BUNDLED_PLUGIN_DIRS } from "../../src/shared/non-packaged-plugin-dirs.ts";
import { collectRootPackageExcludedExtensionDirs } from "./root-package-bundled-plugin-excludes.mjs";

/**
 * Read the completed build and shared catalog policy without changing files or runtime state.
 * @param {string} sourceRoot
 * @returns {Array<{ id: string, dirName: string, hasInstallRoute: boolean, devOnly: boolean, requiresPlugins: string[] }>}
 */
export function classifyStandalonePlugins(sourceRoot) {
  const fetchable = new Set(
    listOfficialExternalPluginCatalogEntries().flatMap((entry) => {
      const install = resolveOfficialExternalPluginInstall(entry);
      const id = resolveOfficialExternalPluginId(entry);
      return id && (install?.npmSpec || install?.clawhubSpec) ? [id] : [];
    }),
  );
  const plugins = new Map();
  const extensionsRoot = path.join(sourceRoot, "dist/extensions");
  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(extensionsRoot, entry.name, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id) || plugins.has(manifest.id)) {
      throw new Error(`Invalid or duplicate bundled plugin ID: ${manifest.id}`);
    }
    plugins.set(manifest.id, {
      id: manifest.id,
      dirName: entry.name,
      hasInstallRoute: fetchable.has(manifest.id),
      devOnly: NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(entry.name),
      requiresPlugins: (manifest.requiresPlugins ?? []).toSorted(),
    });
  }
  return [...plugins.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

/**
 * The completed build, rather than desktop policy, owns the available plugin inventory.
 * @param {string} sourceRoot
 * @param {string[]} [pluginIds]
 */
export function planStandalonePlugins(sourceRoot, pluginIds) {
  const plugins = new Map(
    classifyStandalonePlugins(sourceRoot).map((plugin) => [plugin.id, plugin]),
  );
  const selected = new Set(pluginIds ?? plugins.keys());
  const unknown = [...selected].filter((id) => !plugins.has(id)).toSorted();
  if (unknown.length) {
    throw new Error(
      `Unknown bundled plugin ID(s): ${unknown.join(", ")}. Run pnpm build if an entry is missing.`,
    );
  }
  const embedded = [...selected].toSorted();
  const omitted = [...plugins.keys()].filter((id) => !selected.has(id)).toSorted();
  for (const id of omitted) {
    const plugin = plugins.get(id);
    if (!plugin.hasInstallRoute && !plugin.devOnly) {
      throw new Error(
        `Cannot omit bundled plugin ${id}: no official-external npm/ClawHub install path. Include it in --plugins.`,
      );
    }
  }
  for (const id of embedded) {
    for (const required of plugins.get(id).requiresPlugins) {
      if (!selected.has(required)) {
        throw new Error(
          `Bundled plugin ${id} requires plugin ${required}. Include both in --plugins.`,
        );
      }
    }
  }
  return {
    embedded,
    omitted,
    embeddedDirs: embedded.map((id) => plugins.get(id).dirName).toSorted(),
    omittedDirs: omitted.map((id) => plugins.get(id).dirName).toSorted(),
  };
}

/** Apply artifact membership before discovery, image metadata, or dependency scanning. */
export function pruneStandalonePluginDirectories(runtimeRoot, selection) {
  for (const directory of selection.omittedDirs) {
    for (const parent of ["dist/extensions", "extensions"]) {
      fs.rmSync(path.join(runtimeRoot, parent, directory), { recursive: true, force: true });
    }
  }
  if (selection.omitted.length) {
    // Source-only helper directories (for example test-support) are not runtime plugins.
    const retained = new Set(selection.embeddedDirs);
    const sourceExtensions = path.join(runtimeRoot, "extensions");
    if (fs.existsSync(sourceExtensions)) {
      for (const entry of fs.readdirSync(sourceExtensions, { withFileTypes: true })) {
        if (entry.isDirectory() && !retained.has(entry.name)) {
          fs.rmSync(path.join(sourceExtensions, entry.name), { recursive: true });
        }
      }
    }
    // Cached help/channel options describe the full source build. Normal rendering uses this artifact.
    fs.rmSync(path.join(runtimeRoot, "dist/cli-startup-metadata.json"), { force: true });
  }
  const packagePath = path.join(runtimeRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const excluded = collectRootPackageExcludedExtensionDirs({ files: manifest.files ?? [] });
  const excludedEntries = new Set([...excluded].map((dir) => `!dist/extensions/${dir}/**`));
  manifest.files = [
    ...(manifest.files ?? []).filter((entry) => !excludedEntries.has(entry)),
    ...selection.omittedDirs.map((dir) => `!dist/extensions/${dir}/**`),
  ];
  fs.writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + "\n");
}

/** Share hash-checked plugin chunk ownership and retained-import rescue with loose packaging. */
export async function selectStandalonePluginModules(runtimeRoot, moduleEntries, selection) {
  if (!selection.omitted.length) {
    return moduleEntries;
  }
  const { resolveNodeBootstrapRuntimeChunks } =
    await import("../../src/gateway/worker-environments/node-bootstrap-runtime-chunks.ts");
  const { files } = await resolveNodeBootstrapRuntimeChunks(
    runtimeRoot,
    moduleEntries,
    [],
    new Set(selection.omittedDirs),
  );
  return files;
}
