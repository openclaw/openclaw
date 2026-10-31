import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { standaloneSourceContextIdentity } from "./bun-standalone-source-identity.mjs";
import { pluginRuntimeExtension } from "./bundled-plugin-build-entries.mjs";
import { bundledDistPluginFile } from "./bundled-plugin-paths.mjs";
import { readStandaloneSourceModuleIdentities } from "./standalone-source-module-urls.mjs";

const posix = (value) => value.split(path.sep).join("/");

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function semanticContext(config, format, sourceRoot) {
  if (!config) {
    return { semanticInputsKnown: false };
  }
  const inputs = {
    format: format === "es" ? "esm" : format,
    platform: config?.platform ?? "node",
    target: config?.target,
    define: config?.define ?? {},
    env: config?.env ?? {},
    alias: config?.alias ?? {},
    tsconfig: config?.tsconfig,
    plugins: [config?.plugins]
      .flat(Infinity)
      .filter(Boolean)
      .map((plugin) => plugin.name),
  };
  const identity = standaloneSourceContextIdentity(sourceRoot, inputs);
  const hash = createHash("sha256")
    .update(JSON.stringify(stableValue(identity)))
    .digest("hex");
  return {
    semanticInputsKnown: true,
    semanticHash: hash,
    semanticInputs: inputs,
    contextId: `source:${hash.slice(0, 16)}`,
  };
}

function relativePath(root, filename) {
  const relative = path.relative(root, filename);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Standalone source entry escapes source root: ${filename}`);
  }
  return posix(relative);
}

function sourceLoader(filename) {
  if (/\.d\.[cm]?ts$/u.test(filename)) {
    throw new Error(`Declaration file cannot be a standalone runtime entry: ${filename}`);
  }
  if (filename.endsWith(".tsx")) {
    return "tsx";
  }
  if (/\.[cm]?ts$/u.test(filename)) {
    return "ts";
  }
  if (filename.endsWith(".jsx")) {
    return "jsx";
  }
  if (/\.[cm]?js$/u.test(filename)) {
    return "js";
  }
  throw new Error(`Unsupported standalone source entry: ${filename}`);
}

function entryOutput(config, name, source, format, packageType) {
  const outputOptions = config.outputOptions ?? {};
  if (typeof outputOptions !== "object" || Array.isArray(outputOptions)) {
    throw new Error("Standalone source entries require resolved outputOptions");
  }
  let pattern = outputOptions.entryFileNames;
  if (typeof pattern === "function") {
    pattern = pattern({ name, isEntry: true, facadeModuleId: source });
  }
  if (pattern === undefined) {
    const extensionOptions = config.outExtensions?.({
      options: config,
      format: format === "esm" ? "es" : format,
      pkgType: packageType,
    });
    // tsdown's node defaults use fixed extensions; nodeBuildConfig explicitly opts out.
    const fixedExtension = config.fixedExtension ?? (config.platform ?? "node") === "node";
    const extension =
      extensionOptions?.js ??
      (format === "cjs"
        ? fixedExtension || packageType === "module"
          ? ".cjs"
          : ".js"
        : !fixedExtension && packageType === "module"
          ? ".js"
          : ".mjs");
    pattern = `[name]${extension}`;
  }
  if (typeof pattern !== "string" || /\[(?!name\])/u.test(pattern)) {
    throw new Error(`Standalone source entry has a non-stable output name: ${name}`);
  }
  return pattern.replaceAll("[name]", name);
}

/**
 * @typedef {Omit<import("tsdown").UserConfig, "entry" | "outputOptions"> & {
 *   entry?: Record<string, string>,
 *   outputOptions?: Exclude<import("tsdown").UserConfig["outputOptions"], Function>
 * }} StandaloneSourceConfig
 * @typedef {Pick<ReturnType<typeof import("./bundled-plugin-build-entries.mjs").collectSourceCheckoutPluginBuildEntries>[number], "id" | "sourceEntries" | "runtimeExtension"> & (
 *   { isolated: false } | {
 *     isolated: true,
 *     runtimeBuildConfigs: (StandaloneSourceConfig & { entry: Record<string, string> })[],
 *     runtimeBuildPlan: import("./plugin-npm-runtime-build.mts").PluginNpmRuntimeBuildPlan
 *   }
 * )} StandaloneSourcePluginEntry
 */

/**
 * Resolve named runtime contracts from their build owners, retaining original TypeScript.
 * @param {{
 *   sourceRoot: string,
 *   configs: StandaloneSourceConfig[],
 *   pluginPlans?: import("./plugin-npm-runtime-build.mts").PluginNpmRuntimeBuildPlan[],
 *   pluginEntries?: StandaloneSourcePluginEntry[],
 *   workerEntries?: string[],
 *   originalJavaScriptEntries?: string[]
 * }} options
 */
export function createStandaloneSourceEntries({
  sourceRoot: requestedSourceRoot,
  configs,
  pluginPlans = [],
  pluginEntries = [],
  workerEntries = [],
  originalJavaScriptEntries = [],
}) {
  const sourceRoot = path.resolve(requestedSourceRoot);
  const originalJavaScript = new Set(originalJavaScriptEntries);
  const byOutput = new Map();
  const moduleUrlsByConfig = new WeakMap();
  const sourceFacts = new Map();
  const packages = new Map();
  const readPackage = (directory) => {
    if (!packages.has(directory)) {
      const filename = path.join(directory, "package.json");
      packages.set(
        directory,
        fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : undefined,
      );
    }
    return packages.get(directory);
  };
  // tsdown externalizes runtime dependency names from the nearest package to the build cwd.
  const dependenciesByConfig = new WeakMap();
  const getPackageDependencies = (config) => {
    if (!dependenciesByConfig.has(config)) {
      let directory = path.resolve(sourceRoot, config.cwd ?? ".");
      let manifest;
      while (!(manifest = readPackage(directory))) {
        const parent = path.dirname(directory);
        if (parent === directory) {
          break;
        }
        directory = parent;
      }
      dependenciesByConfig.set(
        config,
        Object.keys({
          ...manifest?.dependencies,
          ...manifest?.peerDependencies,
          ...manifest?.peerDependenciesMeta,
          ...manifest?.optionalDependencies,
        }),
      );
    }
    return dependenciesByConfig.get(config);
  };
  const add = (output, input, config, format, extra = {}) => {
    const source = path.resolve(sourceRoot, input);
    const relativeSource = relativePath(sourceRoot, source);
    const relativeOutput = relativePath(sourceRoot, path.resolve(sourceRoot, output));
    if (byOutput.has(relativeOutput)) {
      throw new Error(`Multiple build owners for standalone entry: ${relativeOutput}`);
    }
    let facts = sourceFacts.get(source);
    if (!facts) {
      const contents = fs.readFileSync(source);
      facts = {
        source,
        relativeSource,
        sourceSha256: createHash("sha256").update(contents).digest("hex"),
        loader: sourceLoader(source),
      };
      sourceFacts.set(source, facts);
    }
    byOutput.set(relativeOutput, {
      output: relativeOutput,
      ...facts,
      format,
      config,
      configIndex: config && configs.includes(config) ? configs.indexOf(config) : undefined,
      ...semanticContext(config, format, sourceRoot),
      ...extra,
    });
  };
  for (const config of configs) {
    if (config.dts && typeof config.dts === "object" && config.dts.emitDtsOnly) {
      continue;
    }
    if (!config.entry || Array.isArray(config.entry) || typeof config.entry !== "object") {
      throw new Error("Standalone source entries require named build entry maps");
    }
    const cwd = path.resolve(sourceRoot, config.cwd ?? ".");
    const packageType = readPackage(cwd)?.type;
    readPackage(path.dirname(path.resolve(cwd, config.outDir ?? "dist")));
    const formats = Array.isArray(config.format) ? config.format : [config.format ?? "esm"];
    for (const format of formats) {
      if (!["esm", "es", "cjs"].includes(format)) {
        throw new Error(`Unsupported standalone entry format: ${JSON.stringify(format)}`);
      }
      for (const [name, input] of Object.entries(config.entry)) {
        const source = path.resolve(cwd, input);
        const output = entryOutput(config, name, source, format, packageType);
        add(path.resolve(cwd, config.outDir ?? "dist", output), source, config, format);
      }
    }
  }
  for (const plan of pluginPlans) {
    for (const [name, source] of Object.entries(plan.entry)) {
      add(
        path.join(plan.outDir, `${name}${pluginRuntimeExtension(plan.runtimeFormat)}`),
        source,
        undefined,
        plan.runtimeFormat,
        {
          pluginPlan: plan,
          contextId: `plugin:${relativePath(sourceRoot, plan.packageDir ?? plan.outDir)}`,
        },
      );
    }
  }
  for (const plugin of pluginEntries.filter((entry) => entry.isolated)) {
    for (const [configIndex, config] of plugin.runtimeBuildConfigs.entries()) {
      for (const [name, source] of Object.entries(config.entry)) {
        add(
          bundledDistPluginFile(plugin.id, `${name}${plugin.runtimeExtension}`),
          source,
          config,
          plugin.runtimeExtension === ".cjs" ? "cjs" : "esm",
          {
            pluginEntry: plugin,
            pluginPlan: plugin.runtimeBuildPlan,
            moduleUrlOutputRoot: bundledDistPluginFile(plugin.id, ""),
            contextId: `plugin:${plugin.id}:${configIndex}`,
          },
        );
      }
    }
  }
  const resolve = (output) =>
    byOutput.get(relativePath(sourceRoot, path.resolve(sourceRoot, output)));
  const moduleIdentities = (source, config) => {
    if (!config || typeof config !== "object") {
      throw new Error(`Missing build configuration for emitted module URL: ${source}`);
    }
    let urls = moduleUrlsByConfig.get(config);
    if (!urls) {
      const records = [...byOutput.values()].filter((entry) => entry.config === config);
      const entries = records.map((entry) => ({
        output: entry.output,
        source: entry.relativeSource,
      }));
      // The isolated-plugin build moves its complete backend output into root dist.
      const outputRoot = records[0]?.moduleUrlOutputRoot
        ? path.resolve(sourceRoot, records[0].moduleUrlOutputRoot)
        : path.resolve(sourceRoot, config.cwd ?? ".", config.outDir ?? "dist");
      urls = readStandaloneSourceModuleIdentities({ sourceRoot, outputRoot, entries });
      moduleUrlsByConfig.set(config, urls);
    }
    return urls;
  };
  const moduleUrlTargets = (source, config) =>
    moduleIdentities(source, config).rendered.get(source);
  const isUnrenderedSource = (source, config) => moduleUrlTargets(source, config)?.length === 0;
  const oneModuleUrl = (source, targets) => {
    if (targets.length !== 1) {
      throw new Error(
        `Expected one emitted module URL for ${source}; found ${targets.length}: ${targets.join(", ")}`,
      );
    }
    return targets[0];
  };
  const resolveModuleUrl = (source, config) =>
    oneModuleUrl(source, moduleUrlTargets(source, config) ?? []);
  const resolveEmittedModuleUrl = (source, config) => {
    const identities = moduleIdentities(source, config);
    return oneModuleUrl(
      source,
      identities.facades.get(source) ?? identities.rendered.get(source) ?? [],
    );
  };
  const runtimeTargets = (value) => {
    if (typeof value === "string") {
      return /\.d\.[cm]?ts$/u.test(value) ? [] : [value];
    }
    if (!value || typeof value !== "object") {
      return [];
    }
    return Object.entries(value).flatMap(([condition, target]) =>
      condition === "types" ? [] : runtimeTargets(target),
    );
  };
  const importEntries = new Map();
  for (const [directory, manifest] of packages) {
    if (!manifest?.name || !manifest.exports) {
      continue;
    }
    const exports =
      typeof manifest.exports === "object" &&
      Object.keys(manifest.exports).some((key) => key.startsWith("."))
        ? manifest.exports
        : { ".": manifest.exports };
    for (const [subpath, target] of Object.entries(exports)) {
      const records = [
        ...new Set(
          runtimeTargets(target)
            .map((entry) => resolve(path.resolve(directory, entry)))
            .filter(Boolean),
        ),
      ];
      if (records.length === 1) {
        importEntries.set(manifest.name + subpath.slice(1), records[0]);
      }
    }
  }
  /** @param {string[]} moduleEntries */
  const selectRuntimeEntries = (moduleEntries) =>
    moduleEntries.filter(
      (entry) => !entry.startsWith("dist/") || workerEntries.includes(entry) || resolve(entry),
    );
  return {
    entries: [...byOutput.values()],
    byOutput,
    selectRuntimeEntries,
    getPackageDependencies,
    resolve,
    isUnrenderedSource,
    resolveModuleUrl,
    resolveEmittedModuleUrl,
    resolveImport: (specifier) => importEntries.get(specifier),
    unmappedWorkers: (workers) =>
      workers.filter((worker) => !resolve(worker) && !originalJavaScript.has(worker)),
  };
}

/** Load the repository's build owners without running their build hooks or changing cwd. */
export async function loadStandaloneSourceEntries(options) {
  const sourceRoot = path.resolve(options.sourceRoot);
  if (path.resolve(process.cwd()) !== sourceRoot) {
    throw new Error("Load standalone source entries from the source-root working directory");
  }
  if (process.env.OPENCLAW_TSDOWN_CACHE_PENDING) {
    throw new Error("Disable tsdown output-cache restoration before loading source entries");
  }
  const load = (relative) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
  const [{ default: configs }, { default: ai }, plugins, runtimePlans, processManifest, assets] =
    await Promise.all([
      load("tsdown.config.ts"),
      load("tsdown.ai.config.ts"),
      load("scripts/lib/bundled-plugin-build-entries.mjs"),
      load("scripts/lib/plugin-npm-runtime-build.mts"),
      load("src/infra/runtime-process-manifest.ts"),
      load("scripts/lib/static-extension-assets.mts"),
    ]);
  const pluginEntries = plugins
    .collectSourceCheckoutPluginBuildEntries({ cwd: sourceRoot })
    .map((entry) => {
      if (!entry.isolated) {
        return entry;
      }
      const runtimeBuildPlan = runtimePlans.resolvePluginNpmRuntimeBuildPlan({
        repoRoot: sourceRoot,
        packageDir: path.join("extensions", entry.id),
      });
      if (!runtimeBuildPlan) {
        throw new Error(`Missing isolated plugin runtime build plan: ${entry.id}`);
      }
      return Object.assign(entry, {
        runtimeBuildPlan,
        runtimeBuildConfigs: runtimePlans.createPluginNpmRuntimeBuildOptions(runtimeBuildPlan),
      });
    });
  // These programs are already original JavaScript. Their existing manifest and
  // static-asset owners identify them; no emitted-source scanning is needed.
  const originalJavaScriptEntries = [
    ...Object.values(processManifest.createStandaloneRuntimeProcessEntrypoints(import.meta.url, []))
      .map((entry) => entry.distWorkerPath)
      .filter((entry) => entry.startsWith("../"))
      .map((entry) => path.posix.normalize(`dist/${entry}`)),
    ...assets
      .discoverStaticExtensionAssets({ rootDir: sourceRoot, includeExternalPlugins: true })
      .filter(({ src }) => /\.[cm]?js$/u.test(src))
      .map(({ dest }) => dest),
  ];
  return createStandaloneSourceEntries({
    ...options,
    sourceRoot,
    configs: [...configs, ai],
    pluginEntries,
    originalJavaScriptEntries,
  });
}
