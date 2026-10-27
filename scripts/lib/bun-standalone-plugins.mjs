import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../../src/plugins/official-external-plugin-catalog.ts";
import { listBuiltRuntimeEntryCandidates } from "../../src/plugins/package-entrypoints.ts";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  resolvePackageExtensionEntries,
} from "../../src/plugins/package-manifest.ts";
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

/**
 * @typedef {{source: string, entry: string}} CompiledPluginEntry
 * @typedef {{runtime: CompiledPluginEntry[], setup?: CompiledPluginEntry}} CompiledPluginEntries
 * @typedef {{schemaVersion: 1, sdk: Record<string, CompiledPluginEntry>,
 *   plugins: Record<string, CompiledPluginEntries>}} StandalonePluginContract
 * @typedef {{id?: string, exports?: Record<string, string | {default?: string}>,
 *   openclaw?: {extensions?: string[], setupEntry?: string}}} PluginContractManifest
 */

/** @param {string} root @param {string} name @returns {PluginContractManifest} */
function readPluginContractManifest(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
}

/**
 * @param {string} root
 * @param {string} filename
 * @param {Record<string, string>} entries
 * @param {string} label
 * @returns {CompiledPluginEntry}
 */
function compiledPluginEntry(root, filename, entries, label) {
  const relative = path.relative(root, path.resolve(root, filename)).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the standalone runtime: ${filename}`);
  }
  if (!Object.hasOwn(entries, relative)) {
    throw new Error(
      `${label} is missing its compiled entry: ${relative}. Run pnpm build and rebuild the standalone artifact.`,
    );
  }
  return { source: relative, entry: entries[relative] };
}

/**
 * Package exports and plugin manifests own the names; the compiled image owns their code.
 * @param {{runtimeRoot: string, plugins: {embedded: readonly string[], embeddedDirs: readonly string[]},
 *   embeddedPaths: Record<string, string>}} options
 * @returns {StandalonePluginContract}
 */
export function createStandalonePluginContract({ runtimeRoot, plugins, embeddedPaths }) {
  const rootManifest = readPluginContractManifest(runtimeRoot, "package.json");
  /** @type {Record<string, CompiledPluginEntry>} */
  const sdk = {};
  for (const [name, target] of Object.entries(rootManifest.exports ?? {})) {
    if (!name.startsWith("./plugin-sdk/")) {
      continue;
    }
    const runtime = typeof target === "string" ? target : target?.default;
    if (typeof runtime !== "string") {
      throw new Error(`Plugin SDK export ${name} has no runtime entry`);
    }
    sdk[`openclaw/${name.slice(2)}`] = compiledPluginEntry(
      runtimeRoot,
      runtime,
      embeddedPaths,
      `Plugin SDK export ${name}`,
    );
  }
  if (Object.keys(sdk).length === 0) {
    throw new Error("Standalone runtime has no compiled Plugin SDK exports");
  }
  /** @type {Record<string, CompiledPluginEntries>} */
  const compiledPlugins = {};
  const selected = new Set(plugins.embedded);
  for (const directory of plugins.embeddedDirs) {
    const root = `dist/extensions/${directory}`;
    const plugin = readPluginContractManifest(runtimeRoot, `${root}/openclaw.plugin.json`);
    if (typeof plugin.id !== "string" || !selected.delete(plugin.id)) {
      throw new Error(`Unexpected or duplicate bundled plugin ID: ${plugin.id}`);
    }
    const pkg = fs.existsSync(path.join(runtimeRoot, root, "package.json"))
      ? readPluginContractManifest(runtimeRoot, `${root}/package.json`)
      : undefined;
    const metadata = getPackageManifestMetadata(pkg);
    const resolution = resolvePackageExtensionEntries(pkg);
    if (resolution.status === "invalid" || resolution.status === "empty") {
      throw new Error(
        `Bundled plugin ${plugin.id}: ${resolution.status === "invalid" ? resolution.error : "package.json openclaw.extensions is empty"}`,
      );
    }
    const fallback =
      resolution.status === "missing"
        ? DEFAULT_PLUGIN_ENTRY_CANDIDATES.find((candidate) =>
            fs.existsSync(path.join(runtimeRoot, root, candidate)),
          )
        : undefined;
    const declared = resolution.status === "ok" ? resolution.entries : fallback ? [fallback] : [];
    if (declared.length === 0) {
      throw new Error(`Bundled plugin ${plugin.id} has no runtime entry`);
    }
    /** @param {string} filename @returns {CompiledPluginEntry} */
    const entry = (filename) => {
      if (typeof filename !== "string" || !filename.trim()) {
        throw new Error(`Bundled plugin ${plugin.id} has an invalid runtime entry`);
      }
      const normalized = path.posix.normalize(filename.replace(/\\/g, "/"));
      if (
        path.posix.isAbsolute(normalized) ||
        normalized === ".." ||
        normalized.startsWith("../")
      ) {
        throw new Error(`Bundled plugin ${plugin.id} entry is outside its package: ${filename}`);
      }
      const built = listBuiltRuntimeEntryCandidates(filename);
      const candidates = [...built, filename].map((candidate) => path.posix.join(root, candidate));
      const source = candidates.find((candidate) => Object.hasOwn(embeddedPaths, candidate));
      return compiledPluginEntry(
        runtimeRoot,
        source ?? path.posix.join(root, built[0] ?? filename),
        embeddedPaths,
        `Bundled plugin ${plugin.id}`,
      );
    };
    compiledPlugins[plugin.id] = {
      runtime: declared.map(entry),
      ...(metadata?.setupEntry === undefined ? {} : { setup: entry(metadata.setupEntry) }),
    };
  }
  if (selected.size > 0) {
    throw new Error(`Missing bundled plugin directories: ${[...selected].join(", ")}`);
  }
  return { schemaVersion: 1, sdk, plugins: compiledPlugins };
}

const STANDALONE_PLUGIN_LOADER_SPECIFIER = "@openclaw/plugin-loader";
const STANDALONE_PLUGIN_LOADER_DIRECTORY = "node_modules/@openclaw/plugin-loader";

/**
 * Keep the dynamic loader, including Jiti's lazy transform, in one host-owned disk package.
 * @param {{runtimeRoot: string, outputRoot: string, build: (options: {
 *   entrypoints: string[], outdir: string, naming: string, target: "bun", format: "cjs",
 *   minify: {whitespace: boolean, syntax: boolean, identifiers: boolean}
 * }) => Promise<{success: boolean, logs: Iterable<unknown>}>}} options
 */
export async function stageStandalonePluginLoader({ runtimeRoot, outputRoot, build }) {
  const require = createRequire(path.join(runtimeRoot, "package.json"));
  const jiti = require.resolve("jiti");
  const packageRoot = path.dirname(require.resolve("jiti/package.json"));
  const entrypoint = path.join(outputRoot, "plugin-loader-entry.cjs");
  fs.writeFileSync(
    entrypoint,
    `const { createRequire } = require("node:module");
exports.loadModule = (parent, specifier) => createRequire(parent)(specifier);
exports.createJiti = (...args) => require(${JSON.stringify(jiti)}).createJiti(...args);
`,
  );
  const directory = path.join(runtimeRoot, STANDALONE_PLUGIN_LOADER_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  try {
    const result = await build({
      entrypoints: [entrypoint],
      outdir: directory,
      naming: "index.cjs",
      target: "bun",
      format: "cjs",
      // Generated source comments otherwise include the random staging directory.
      minify: { whitespace: true, syntax: false, identifiers: false },
    });
    if (!result.success) {
      throw new AggregateError(result.logs, "Could not bundle the standalone plugin loader");
    }
  } finally {
    fs.rmSync(entrypoint, { force: true });
  }
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: STANDALONE_PLUGIN_LOADER_SPECIFIER, private: true, main: "index.cjs" }) +
      "\n",
  );
  fs.copyFileSync(path.join(packageRoot, "LICENSE"), path.join(directory, "LICENSE"));
  return {
    specifier: STANDALONE_PLUGIN_LOADER_SPECIFIER,
    modulePath: `${STANDALONE_PLUGIN_LOADER_DIRECTORY}/index.cjs`,
    files: ["index.cjs", "package.json", "LICENSE"].map((name) => ({
      source: `${STANDALONE_PLUGIN_LOADER_DIRECTORY}/${name}`,
      destination: `${STANDALONE_PLUGIN_LOADER_DIRECTORY}/${name}`,
      category: "pluginLoader",
    })),
  };
}
