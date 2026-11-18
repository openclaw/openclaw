import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { standaloneSourceContextIdentity } from "./bun-standalone-source-identity.mjs";
import { LOCAL_PLUGIN_ROOT } from "./extension-boundary-inputs.mts";

const slash = (value) => value.split(path.sep).join("/");
const within = (root, filename) => {
  const relative = path.relative(root, filename);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function linkInput(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    return;
  }
  try {
    fs.linkSync(source, target);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
  }
}

function matchesExternal(option, id, importer) {
  if (typeof option === "function") {
    return option(id, importer, false) === true;
  }
  if (Array.isArray(option)) {
    return option.some((entry) => matchesExternal(entry, id, importer));
  }
  if (option instanceof RegExp) {
    return option.test(id);
  }
  return option === true || option === id;
}

/**
 * Materialize original inputs, preserving each build context and its runtime aliases.
 * @param {{
 *   sourceRoot: string,
 *   runtimeRoot: string,
 *   outputRoot: string,
 *   sourceEntries: ReturnType<typeof import("./bun-standalone-source-entries.mjs").createStandaloneSourceEntries>,
 *   defaultConfig?: import("./bun-standalone-source-entries.mjs").StandaloneSourceConfig,
 *   embeddedPaths: Record<string, string>,
 *   resolveSource?: (specifier: string, directory: string) => string
 * }} options
 */
export function createStandaloneSourceGraph({
  sourceRoot,
  runtimeRoot,
  outputRoot,
  sourceEntries,
  defaultConfig,
  embeddedPaths,
  resolveSource = (specifier, directory) => Bun.resolveSync(specifier, directory),
}) {
  const contexts = new Map();
  const contextsByConfig = new WeakMap();
  const files = new Map();
  const roots = new Set();
  const loaded = new Map();
  const sourcePrefix = path.join(runtimeRoot, ".typed-source");
  const dependencyPackages = new Map();
  const dependencyDirectories = new Map();
  const dependencyLinks = (directory) => {
    let links = dependencyDirectories.get(directory);
    if (links) {
      return links;
    }
    links = new Map();
    if (fs.existsSync(directory)) {
      const add = (name, source) => {
        const stat = fs.statSync(source, { throwIfNoEntry: false });
        if (stat?.isDirectory()) {
          links.set(name, fs.realpathSync(source));
        }
      };
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const source = path.join(directory, entry.name);
        if (entry.name.startsWith("@")) {
          for (const child of fs.readdirSync(source)) {
            add(`${entry.name}/${child}`, path.join(source, child));
          }
        } else {
          add(entry.name, source);
        }
      }
    }
    dependencyDirectories.set(directory, links);
    return links;
  };
  const dependencyPackage = (source) => {
    const relative = path.relative(sourceRoot, source);
    if (!relative.startsWith(`node_modules${path.sep}`)) {
      return undefined;
    }
    const parts = relative.split(path.sep);
    const index = parts.lastIndexOf("node_modules") + 1;
    const length = parts[index].startsWith("@") ? 2 : 1;
    const root = path.join(sourceRoot, ...parts.slice(0, index + length));
    let entry = dependencyPackages.get(root);
    if (entry) {
      return entry;
    }
    const inputs = [];
    const collect = (directory) => {
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        if (child.name === "node_modules" || child.name === ".git") {
          continue;
        }
        const filename = path.join(directory, child.name);
        if (child.isDirectory()) {
          collect(filename);
        } else if (/\.(?:[cm]?[jt]sx?|json)$/.test(child.name) && fs.statSync(filename).isFile()) {
          inputs.push({
            source: child.isSymbolicLink() ? fs.realpathSync(filename) : filename,
            relative: path.relative(root, filename),
          });
        }
      }
    };
    collect(root);
    const sharedDependencyDirectory = path.join(
      sourceRoot,
      "node_modules",
      ".pnpm",
      "node_modules",
    );
    const sharedDependencyParent = path.dirname(sharedDependencyDirectory);
    const sharesDependencies =
      within(sharedDependencyParent, root) && fs.existsSync(sharedDependencyDirectory);
    const dependencies = new Map();
    for (let directory = root; within(sourceRoot, directory); directory = path.dirname(directory)) {
      if (path.basename(directory) === "node_modules") {
        continue;
      }
      const dependencyDirectory = path.join(directory, "node_modules");
      // The common hoist and root fallback already have contextual ancestors.
      if (
        sharesDependencies &&
        (dependencyDirectory === sharedDependencyDirectory || directory === sourceRoot)
      ) {
        continue;
      }
      for (const [name, target] of dependencyLinks(dependencyDirectory)) {
        if (!dependencies.has(name)) {
          dependencies.set(name, target);
        }
      }
      if (directory === sourceRoot) {
        break;
      }
    }
    entry = {
      root,
      name: parts.slice(index, index + length).join(path.sep),
      id: createHash("sha256").update(path.relative(sourceRoot, root)).digest("hex").slice(0, 16),
      inputs,
      dependencies,
      sharedDependencyDirectory: sharesDependencies ? sharedDependencyDirectory : undefined,
    };
    dependencyPackages.set(root, entry);
    return entry;
  };
  const dependencyRoot = (entry, context) =>
    path.join(
      context.directory,
      ".modules",
      "node_modules",
      entry.sharedDependencyDirectory ? ".packages" : ".isolated-packages",
      entry.id,
      entry.name,
    );
  const mirrorDependencyPackage = (entry, context) => {
    if (context.dependencyPackages.has(entry.root)) {
      return;
    }
    const directory = dependencyRoot(entry, context);
    if (entry.sharedDependencyDirectory && !context.sharedDependencyDirectory) {
      const target = path.join(
        context.directory,
        ".modules",
        "node_modules",
        ".packages",
        "node_modules",
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(entry.sharedDependencyDirectory, target, "dir");
      context.sharedDependencyDirectory = entry.sharedDependencyDirectory;
    }
    for (const { source, relative } of entry.inputs) {
      linkInput(source, path.join(directory, relative));
    }
    // Each package has an isolated destination: these type-resolution links can
    // never become parents of another package's materialized runtime sources.
    for (const [name, source] of entry.dependencies) {
      const target = path.join(directory, "node_modules", name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(source, target, "dir");
    }
    context.dependencyPackages.add(entry.root);
  };
  let typeInputRoots;
  const mirrorTypeInputs = (directory) => {
    if (!typeInputRoots) {
      const sharedRoot = path.join(sourcePrefix, "type-inputs");
      const folders = new Map();
      const omitted = new Set(["dist", ".git", ".artifacts"]);
      // Package-boundary configs refer to generated declarations, never their runtime output.
      const linkDeclarations = (source, target, preserveDependencies = false) => {
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
          const childSource = path.join(source, entry.name);
          const childTarget = path.join(target, entry.name);
          if (entry.name === "node_modules" && preserveDependencies) {
            fs.mkdirSync(target, { recursive: true });
            fs.symlinkSync(childSource, childTarget, "dir");
          } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
            if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
              linkDeclarations(childSource, childTarget, preserveDependencies);
            }
          } else if (/\.d\.[cm]?ts$/.test(entry.name)) {
            fs.mkdirSync(target, { recursive: true });
            fs.symlinkSync(childSource, childTarget);
          }
        }
      };
      const inspect = (source) => {
        const entries = fs.readdirSync(source, { withFileTypes: true });
        let needsDirectory = false;
        for (const entry of entries) {
          if (entry.name === "node_modules" || omitted.has(entry.name)) {
            needsDirectory = true;
          } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
            needsDirectory = inspect(path.join(source, entry.name)) || needsDirectory;
          }
        }
        folders.set(source, { entries, needsDirectory });
        return needsDirectory;
      };
      const linkTree = (source, target) => {
        const folder = folders.get(source);
        if (!folder?.needsDirectory) {
          fs.symlinkSync(source, target, "dir");
          return;
        }
        fs.mkdirSync(target, { recursive: true });
        for (const entry of folder.entries) {
          if (entry.name === "dist") {
            linkDeclarations(path.join(source, entry.name), path.join(target, entry.name));
            continue;
          }
          if (omitted.has(entry.name)) {
            continue;
          }
          const childSource = path.join(source, entry.name);
          const childTarget = path.join(target, entry.name);
          if (entry.name === "node_modules") {
            const dependencies = path.join(runtimeRoot, path.relative(sourceRoot, childSource));
            if (fs.existsSync(dependencies)) {
              fs.symlinkSync(dependencies, childTarget, "dir");
            }
          } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
            linkTree(childSource, childTarget);
          } else {
            fs.symlinkSync(childSource, childTarget);
          }
        }
      };
      fs.mkdirSync(sharedRoot, { recursive: true });
      typeInputRoots = [];
      for (const name of [
        "src",
        "extensions",
        "packages",
        "ui",
        "scripts",
        "test",
        "config",
        ".artifacts/kysely",
      ]) {
        const source = path.join(sourceRoot, name);
        if (fs.existsSync(source)) {
          inspect(source);
          const target = path.join(sharedRoot, name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          linkTree(source, target);
          typeInputRoots.push({ name, target });
        }
      }
      const pluginDeclarations = path.join(sourceRoot, LOCAL_PLUGIN_ROOT);
      if (fs.existsSync(pluginDeclarations)) {
        const target = path.join(sharedRoot, LOCAL_PLUGIN_ROOT);
        fs.mkdirSync(target, { recursive: true });
        // Private declarations retain the producing plugin's third-party type scope.
        linkDeclarations(pluginDeclarations, target, true);
        typeInputRoots.push({ name: LOCAL_PLUGIN_ROOT, target });
      }
    }
    // Type-only imports bypass onResolve. Share their unchanged inputs while
    // retaining a distinct contextual path for runtime transforms in onLoad.
    for (const { name, target } of typeInputRoots) {
      const filename = path.join(directory, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.symlinkSync(target, filename, "dir");
    }
  };
  const serialized = (value) =>
    JSON.stringify(value, (_key, item) =>
      item instanceof RegExp ? { regexp: item.source, flags: item.flags } : item,
    );
  const contextFor = (config = defaultConfig) => {
    if (!config || typeof config !== "object") {
      throw new Error("Original source requires its owning build configuration");
    }
    const known = contextsByConfig.get(config);
    if (known) {
      return known;
    }
    const description = {
      define: config.define ?? {},
      env: config.env ?? {},
      alias: config.alias ?? {},
      tsconfig: config.tsconfig,
      cwd: config.cwd,
    };
    // A plugin name does not identify its captured closure (e.g. a plugin root).
    // Keep exact configuration objects separate, even when their scalar options match.
    const identity = standaloneSourceContextIdentity(sourceRoot, description);
    const id = `${contexts.size}-${createHash("sha256").update(serialized(identity)).digest("hex").slice(0, 12)}`;
    let context = contexts.get(id);
    if (!context) {
      const inputOptions = { external: config.deps?.neverBundle ?? config.external };
      const effectiveOptions =
        typeof config.inputOptions === "function"
          ? config.inputOptions(inputOptions)
          : config.inputOptions;
      if (effectiveOptions instanceof Promise) {
        throw new Error("Standalone source inputOptions must resolve synchronously");
      }
      const external = effectiveOptions?.external ?? inputOptions.external;
      const dependencies = sourceEntries.getPackageDependencies(config);
      const directory = path.join(sourcePrefix, id);
      context = {
        id,
        directory,
        config,
        description,
        copiedDirectories: new Set(),
        dependencyPackages: new Set(),
        external: (specifier, importer) =>
          !matchesExternal(config.deps?.alwaysBundle ?? config.noExternal, specifier, importer) &&
          (matchesExternal(external, specifier, importer) ||
            dependencies.some((name) => specifier === name || specifier.startsWith(`${name}/`))),
      };
      contexts.set(id, context);
      contextsByConfig.set(config, context);
      fs.mkdirSync(directory, { recursive: true });
      for (const name of fs.readdirSync(sourceRoot)) {
        if (name === "package.json") {
          const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceRoot, name), "utf8"));
          // Contexts share the runtime package; only real nested manifests create package boundaries.
          fs.writeFileSync(
            path.join(directory, name),
            JSON.stringify({ type: sourcePackage.type === "module" ? "module" : "commonjs" }),
          );
        } else if (/^tsconfig.*\.json$/.test(name)) {
          fs.copyFileSync(path.join(sourceRoot, name), path.join(directory, name));
        } else if (
          /\.[cm]?[jt]s$/.test(name) &&
          fs.statSync(path.join(sourceRoot, name)).isFile()
        ) {
          // Type-only imports also reach root runtime helpers and their declarations.
          fs.symlinkSync(path.join(sourceRoot, name), path.join(directory, name));
        }
      }
      fs.symlinkSync(
        path.relative(directory, path.join(runtimeRoot, "node_modules")),
        path.join(directory, "node_modules"),
        "dir",
      );
      mirrorTypeInputs(directory);
    }
    return context;
  };
  const addAliases = (relative, filename) => {
    const embedded = `/$bunfs/root/${slash(path.relative(outputRoot, filename))}`;
    embeddedPaths[relative] = embedded;
    if (/\.[cm]?tsx?$/.test(relative) && !/\.d\.[cm]?ts$/.test(relative)) {
      embeddedPaths[relative.replace(/\.[cm]?tsx?$/, ".js")] = embedded;
    }
    return embedded;
  };
  const stagedPath = (source, context) => {
    const dependency = dependencyPackage(source);
    return dependency
      ? path.join(dependencyRoot(dependency, context), path.relative(dependency.root, source))
      : path.join(context.directory, path.relative(sourceRoot, source));
  };
  const materializeSourceInput = (source, filename, context) => {
    let directory = context.directory;
    for (const part of path.relative(directory, path.dirname(filename)).split(path.sep)) {
      directory = path.join(directory, part);
      if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
        continue;
      }
      const shared = path.resolve(path.dirname(directory), fs.readlinkSync(directory));
      const children = fs.readdirSync(shared);
      fs.unlinkSync(directory);
      fs.mkdirSync(directory);
      for (const name of children) {
        fs.symlinkSync(path.join(shared, name), path.join(directory, name));
      }
    }
    // Runtime entries need physical contextual names for Bun's multi-entry output.
    // Leave untouched type-only siblings shared; no writes reach the source tree.
    if (fs.lstatSync(filename, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.unlinkSync(filename);
    }
    linkInput(source, filename);
  };
  const materialize = (input, context) => {
    const source = fs.realpathSync(input);
    if (!within(sourceRoot, source)) {
      throw new Error(`Source input escapes checkout: ${source}`);
    }
    const relative = slash(path.relative(sourceRoot, source));
    const filename = stagedPath(source, context);
    if (!files.has(filename)) {
      const dependency = dependencyPackage(source);
      if (dependency) {
        mirrorDependencyPackage(dependency, context);
      }
      if (dependency) {
        linkInput(source, filename);
      } else {
        materializeSourceInput(source, filename, context);
      }
      // Nested tsconfigs and package boundaries remain owned by the repository.
      if (!dependency) {
        for (
          let directory = path.dirname(source);
          within(sourceRoot, directory) && directory !== sourceRoot;
          directory = path.dirname(directory)
        ) {
          if (context.copiedDirectories.has(directory)) {
            continue;
          }
          context.copiedDirectories.add(directory);
          for (const name of fs
            .readdirSync(directory)
            .filter(
              (candidateName) =>
                /^tsconfig.*\.json$/.test(candidateName) || candidateName === "package.json",
            )) {
            const candidate = path.join(directory, name);
            if (fs.existsSync(candidate)) {
              const target = stagedPath(candidate, context);
              fs.mkdirSync(path.dirname(target), { recursive: true });
              if (!fs.existsSync(target)) {
                fs.copyFileSync(candidate, target);
              }
            }
          }
        }
      }
      const loader = source.endsWith(".tsx") ? "tsx" : /\.[cm]?ts$/.test(source) ? "ts" : "js";
      files.set(filename, { filename, source, relative, context, loader });
      addAliases(slash(path.relative(runtimeRoot, filename)), filename);
    }
    return filename;
  };
  const resolveOwned = (target, context, { specifier, importer, external = false } = {}) => {
    // An external edge crosses the caller's bundle boundary: preserve its published owner.
    const shared =
      external ||
      (specifier &&
        !specifier.startsWith(".") &&
        !path.isAbsolute(specifier) &&
        context.external(specifier, importer));
    const exported = shared && sourceEntries.resolveImport?.(specifier);
    if (exported) {
      return addEntry(exported.output);
    }
    if (!within(sourceRoot, target)) {
      return target;
    }
    const relative = slash(path.relative(sourceRoot, target));
    const entry = sourceEntries.resolve(relative);
    if (entry) {
      return shared ? addEntry(entry.output) : materialize(entry.source, context);
    }
    if (
      relative.startsWith("node_modules/") &&
      /\.[cm]?[jt]sx?$/.test(target) &&
      !/\.d\.[cm]?ts$/.test(target)
    ) {
      if (shared) {
        const copied = path.join(runtimeRoot, relative);
        if (!fs.existsSync(copied)) {
          throw new Error(
            `Standalone external dependency is absent from runtime snapshot: ${relative}`,
          );
        }
        return copied;
      }
      return materialize(target, context);
    }
    if (
      !/\.d\.[cm]?ts$/.test(target) &&
      /^(?:src|extensions|packages|scripts)\//.test(relative) &&
      /\.[cm]?[jt]sx?$/.test(target)
    ) {
      return materialize(target, context);
    }
    if (within(sourceRoot, target)) {
      const copied = path.join(runtimeRoot, relative);
      if (fs.existsSync(copied)) {
        return copied;
      }
    }
    return target;
  };
  const addEntry = (entry) => {
    // Generated helpers beside runtime have no original-source build owner.
    if (!within(runtimeRoot, path.resolve(runtimeRoot, entry))) {
      return undefined;
    }
    const record = sourceEntries.resolve(entry);
    if (!record) {
      return undefined;
    }
    const context = contextFor(record.config ?? defaultConfig);
    const filename = materialize(record.source, context);
    const file = files.get(filename);
    file.entryRecord ??= record;
    file.runtimePath ??= entry;
    roots.add(filename);
    embeddedPaths[entry] = addAliases(slash(path.relative(runtimeRoot, filename)), filename);
    return filename;
  };
  const addSource = (source, config) => {
    const filename = materialize(source, contextFor(config));
    roots.add(filename);
    return filename;
  };
  const resolveOriginal = (specifier, importer, config) => {
    let selected = specifier;
    for (const [from, to] of Object.entries(config.alias ?? {})) {
      if (specifier === from || specifier.startsWith(`${from}/`)) {
        selected = to + specifier.slice(from.length);
        break;
      }
    }
    // Package-boundary tsconfigs describe declarations. Runtime exports retain
    // the source owner recorded by the repository's build configuration.
    const exported = sourceEntries.resolveImport?.(selected);
    return exported?.source ?? resolveSource(selected, path.dirname(importer));
  };
  const resolve = ({ path: specifier, importer }) => {
    const original = files.get(importer);
    if (!original) {
      let absolute;
      if (specifier.startsWith("file:")) {
        absolute = fileURLToPath(specifier);
      } else if (path.isAbsolute(specifier)) {
        absolute = specifier;
      } else if (specifier.startsWith(".") && importer) {
        absolute = path.resolve(path.dirname(importer), specifier);
      }
      if (absolute && files.has(absolute)) {
        return { path: absolute };
      }
      if (absolute && within(runtimeRoot, absolute)) {
        const relative = slash(path.relative(runtimeRoot, absolute));
        const selected = addEntry(relative);
        if (selected) {
          return { path: selected };
        }
      }
      return undefined;
    }
    if (/^(?:node:|bun:)/.test(specifier)) {
      return undefined;
    }
    try {
      const target = resolveOriginal(specifier, original.source, original.context.config);
      return {
        path: resolveOwned(target, original.context, { specifier, importer: original.source }),
      };
    } catch (error) {
      if (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") {
        return undefined;
      }
      throw error;
    }
  };
  return {
    roots,
    files,
    contexts,
    loaded,
    workerAliases(workerEntries) {
      const aliases = {};
      for (const entry of workerEntries) {
        const record = sourceEntries.resolve(entry);
        if (!record) {
          continue;
        }
        for (const context of contexts.values()) {
          aliases[stagedPath(record.source, context)] = entry;
        }
      }
      return aliases;
    },
    addEntry,
    addSource,
    addEmittedChunk: ({ id, config }) => {
      const filename = addSource(id, config);
      const file = files.get(filename);
      const runtimePath =
        file.runtimePath ?? sourceEntries.resolveEmittedModuleUrl(file.source, file.context.config);
      const embedded = addAliases(slash(path.relative(runtimeRoot, filename)), filename);
      if (embeddedPaths[runtimePath] !== undefined && embeddedPaths[runtimePath] !== embedded) {
        throw new Error(`Conflicting standalone emitted chunk: ${runtimePath}`);
      }
      file.runtimePath ??= runtimePath;
      embeddedPaths[runtimePath] = embedded;
      return { runtimePath };
    },
    materialize(source, config) {
      return materialize(source, contextFor(config));
    },
    resolveFile(source, config, options) {
      return files.has(source) ? source : resolveOwned(source, contextFor(config), options);
    },
    resolveExternal(specifier, importer, config) {
      if (/^(?:node:|bun:)/.test(specifier)) {
        return undefined;
      }
      const exported = sourceEntries.resolveImport?.(specifier);
      if (exported) {
        return addEntry(exported.output);
      }
      const source = resolveSource(specifier, path.dirname(importer));
      return /\.[cm]?[jt]sx?$/.test(source)
        ? resolveOwned(source, contextFor(config), { specifier, importer, external: true })
        : undefined;
    },
    virtual(source, config) {
      const context = contextFor(config);
      const relative = `.virtual/${createHash("sha256").update(source).digest("hex")}.ts`;
      const filename = path.join(context.directory, relative);
      if (!files.has(filename)) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, "");
        files.set(filename, { filename, source, relative, context, loader: "ts", virtual: true });
      }
      return filename;
    },
    resolveModuleUrl(filename) {
      const file = files.get(filename);
      if (!file || file.virtual || file.relative.startsWith("node_modules/")) {
        return undefined;
      }
      if (sourceEntries.isUnrenderedSource(file.source, file.context.config)) {
        return null;
      }
      return path.join(
        runtimeRoot,
        sourceEntries.resolveModuleUrl(file.source, file.context.config),
      );
    },
    resolveOriginal,
    resolve,
    recordLoaded(filename, contents) {
      const file = files.get(filename);
      if (file) {
        loaded.set(filename, {
          source: file.relative,
          context: file.context.id,
          loader: file.loader,
          originalSha256: file.virtual
            ? undefined
            : createHash("sha256").update(fs.readFileSync(file.source)).digest("hex"),
          compiledSourceSha256: createHash("sha256").update(contents).digest("hex"),
        });
      }
    },
    manifest() {
      return {
        contexts: [...contexts.values()].map(({ id, description }) =>
          Object.assign({ id }, description),
        ),
        roots: [...roots].map((filename) => slash(path.relative(runtimeRoot, filename))),
        files: [...loaded.values()],
      };
    },
  };
}
