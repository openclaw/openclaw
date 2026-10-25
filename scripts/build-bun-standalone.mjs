#!/usr/bin/env bun
// Build a relocatable executable and sidecar from a completed pnpm build.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStandaloneRuntimeProcessEntrypoints } from "../src/infra/runtime-process-manifest.ts";
import {
  WORKSPACE_PACKAGE_ALIAS_ENTRIES,
  WORKSPACE_PACKAGE_EXPORT_DIRS,
  workspacePackageAliasCandidates,
  workspacePackageExportAliasEntries,
} from "../src/plugins/sdk-alias-workspace.ts";
import { createStandaloneArtifactAdapter } from "./lib/bun-standalone-artifacts.mjs";
import { createStandaloneCodegenAdapter } from "./lib/bun-standalone-codegen.mjs";
import {
  assertStandaloneCompiler,
  assertStandalonePlatform,
  parseStandaloneArguments,
  relativeStandaloneEntry,
  resolveStandaloneBuildIdentity,
  sha256File,
  STANDALONE_USAGE,
} from "./lib/bun-standalone-contract.mjs";
import { standaloneEmbeddedPathsExpression } from "./lib/bun-standalone-data.mjs";
import { createStandaloneEntrySource } from "./lib/bun-standalone-entry.mjs";
import {
  assertNoUnrenderedModuleUrls,
  createUnrenderedModuleUrlBootstrap,
  rewriteStandaloneImports,
} from "./lib/bun-standalone-imports.mjs";
import { createStandaloneMetadataAdapter } from "./lib/bun-standalone-metadata.mjs";
import { createStandaloneNativeAdapter } from "./lib/bun-standalone-native.mjs";
import { planStandalonePackageManager } from "./lib/bun-standalone-package-manager.mjs";
import {
  createStandalonePluginContract,
  planStandalonePlugins,
  pruneStandalonePluginDirectories,
  selectStandalonePluginModules,
  stageStandalonePluginLoader,
} from "./lib/bun-standalone-plugins.mjs";
import { createStandaloneRequireAdapter } from "./lib/bun-standalone-require.mjs";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
  standaloneResourceCategory,
} from "./lib/bun-standalone-sidecar.mjs";
import { copyStandaloneRuntime, STANDALONE_RUNTIME_ROOTS } from "./lib/bun-standalone-snapshot.mjs";
import { assertStandaloneSourceBoundaryPrepared } from "./lib/bun-standalone-source-boundary.mjs";
import { writeStandaloneSourceDeclarations } from "./lib/bun-standalone-source-declarations.mjs";
import { loadStandaloneSourceEntries } from "./lib/bun-standalone-source-entries.mjs";
import { createStandaloneSourceGlobals } from "./lib/bun-standalone-source-globals.mjs";
import { createStandaloneSourceGraph } from "./lib/bun-standalone-source-graph.mjs";
import {
  createStandaloneSourceParser,
  standaloneSourceLoader,
} from "./lib/bun-standalone-source-parser.mjs";
import { createStandaloneSourceProject } from "./lib/bun-standalone-source-project.mjs";
import { createStandaloneSourceTransforms } from "./lib/bun-standalone-source-transforms.mjs";
import { stageStandaloneSqlite } from "./lib/bun-standalone-sqlite.mjs";
import {
  assertStandaloneDestinations,
  describeStandaloneNativeModules,
  compileStandaloneArtifacts,
  publishStandaloneArtifacts,
  STANDALONE_BUILD_MARKER,
} from "./lib/bun-standalone-support.mjs";
import { prepareStandaloneWasm, standaloneWasmImport } from "./lib/bun-standalone-wasm.mjs";
import {
  discoverStandaloneWorkers,
  prepareStandaloneWorkers,
} from "./lib/bun-standalone-workers.mjs";
import { rewritePluginNpmRuntimeSpecifiers } from "./lib/plugin-npm-runtime-build.mts";
import { listPackagedStaticExtensionAssetOutputs } from "./lib/static-extension-assets.mts";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseStandaloneArguments(process.argv.slice(2));
const parse = createStandaloneSourceParser();
if (options.help) {
  console.log(STANDALONE_USAGE);
  process.exit(0);
}
assertStandalonePlatform(process.platform);
if (!globalThis.Bun) {
  throw new Error(`Run this builder with Bun.\n${STANDALONE_USAGE}`);
}
const compilerIdentity = spawnSync(process.execPath, ["--revision"], { encoding: "utf8" });
if (compilerIdentity.status !== 0) {
  throw new Error("Cannot determine the Bun compiler revision.");
}
const { mode, compileFlags } = options;
if (mode === "aot") {
  const help = spawnSync(process.execPath, ["build", "--help"], { encoding: "utf8" });
  assertStandaloneCompiler(mode, help.stdout ?? "");
}
const destinationRoot = path.resolve(options.outputDirectory);
const supportDestination =
  options.supportOutputDirectory && path.resolve(options.supportOutputDirectory);
const destinations = [destinationRoot, ...(supportDestination ? [supportDestination] : [])];
assertStandaloneDestinations(destinations);
if (
  destinations.some((destination) =>
    STANDALONE_RUNTIME_ROOTS.some((entry) => {
      const relative = path.relative(path.join(sourceRoot, entry), destination);
      return (
        relative === "" ||
        (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
      );
    }),
  )
) {
  throw new Error(`Choose an output directory outside ${STANDALONE_RUNTIME_ROOTS.join(", ")}.`);
}
if (!fs.existsSync(path.join(sourceRoot, "dist/cli-startup-metadata.json"))) {
  throw new Error("Run pnpm build before building a standalone executable.");
}
const plugins = planStandalonePlugins(sourceRoot, options.pluginIds);
if (options.source) {
  assertStandaloneSourceBoundaryPrepared(sourceRoot);
}
fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
const outputRoot = fs.mkdtempSync(path.join(path.dirname(destinationRoot), ".standalone-build-"));
const runtimeRoot = path.join(outputRoot, "runtime");
console.log(`Building ${mode} standalone in ${outputRoot}`);

copyStandaloneRuntime(sourceRoot, runtimeRoot);
pruneStandalonePluginDirectories(runtimeRoot, plugins);
const declaredPluginAssets = new Set(
  listPackagedStaticExtensionAssetOutputs({ rootDir: runtimeRoot }),
);

let runtimeBuildInfo;
try {
  runtimeBuildInfo = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, "dist/build-info.json"), "utf8"),
  );
} catch (error) {
  throw new Error("Missing or invalid runtime/dist/build-info.json. Run pnpm build.", {
    cause: error,
  });
}
const openclawIdentity = resolveStandaloneBuildIdentity(
  runtimeBuildInfo,
  JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8")).version,
);
const sqlite = stageStandaloneSqlite({
  repoRoot: sourceRoot,
  runtimeRoot,
  bunExecutable: process.execPath,
});

// The existing install owner governs CLI, Gateway/UI and automatic update admission.
fs.writeFileSync(
  path.join(runtimeRoot, "openclaw-install-owner.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      owner: "desktop-app",
      displayName: "OpenClaw standalone build",
      updateHint:
        "Update the owning app, or rebuild and replace openclaw, runtime/ and manifest.json together. See https://docs.openclaw.ai/install/standalone#update-the-complete-artifact.",
    },
    null,
    2,
  ) + "\n",
);

// Do not descend into plugin node_modules: Bun's recursive readdir follows their links.
function runtimeJavaScriptEntries(directory, relative = "") {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "control-ui", "worker-artifacts"].includes(entry.name)) {
      continue;
    }
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      result.push(...runtimeJavaScriptEntries(path.join(directory, entry.name), name));
    } else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) {
      const resource = path
        .relative(runtimeRoot, path.join(directory, entry.name))
        .split(path.sep)
        .join("/");
      if (!standaloneResourceCategory(resource, declaredPluginAssets)) {
        result.push(name);
      }
    }
  }
  return result;
}
// Public built entries are independently addressable. Shared chunks stay shared and lazy.
let moduleEntries = runtimeJavaScriptEntries(path.join(runtimeRoot, "dist"))
  .map((entry) => `dist/${entry}`)
  .toSorted();
const workspaceEntries = [...WORKSPACE_PACKAGE_ALIAS_ENTRIES];
for (const packageDir of WORKSPACE_PACKAGE_EXPORT_DIRS) {
  let manifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, "packages", packageDir, "package.json"), "utf8"),
    );
  } catch {
    // Root-packaged fallbacks are already present in the dist entry inventory.
    continue;
  }
  workspaceEntries.push(
    ...workspacePackageExportAliasEntries({
      packageName: `@openclaw/${packageDir}`,
      packageDir,
      exports: manifest.exports,
    }),
  );
}
for (const entry of workspaceEntries) {
  const candidate = workspacePackageAliasCandidates(entry, "dist").find((name) =>
    fs.existsSync(path.join(runtimeRoot, name)),
  );
  if (candidate && !moduleEntries.includes(candidate)) {
    moduleEntries.push(candidate.split(path.sep).join("/"));
  }
}
moduleEntries.push(
  ...fs
    .readdirSync(runtimeRoot)
    .filter((entry) => entry.endsWith(".mjs"))
    .toSorted(),
);
moduleEntries = await selectStandalonePluginModules(runtimeRoot, moduleEntries, plugins);
const workerEntries = discoverStandaloneWorkers({
  runtimeRoot,
  moduleEntries,
  runtimeEntrypoints: createStandaloneRuntimeProcessEntrypoints(
    import.meta.url,
    plugins.embeddedDirs,
  ),
});
const sourceEntries = options.source
  ? await loadStandaloneSourceEntries({ sourceRoot, workerEntries, parse })
  : undefined;
if (sourceEntries?.unmappedWorkers(workerEntries).length) {
  throw new Error(
    `Unmapped original worker sources: ${sourceEntries.unmappedWorkers(workerEntries).join(", ")}`,
  );
}
const metadataEntries = [...moduleEntries];
// Source discovery retains lazy companions; emitted-JS builds keep their full inventory.
moduleEntries = sourceEntries?.selectRuntimeEntries(moduleEntries) ?? moduleEntries;
const native = createStandaloneNativeAdapter({ runtimeRoot, parse });
native.discover(moduleEntries);
moduleEntries.push(...native.additionalModuleEntries);
// Include conditional ESM/CJS entries reached through computed imports.
for (const packageName of ["@openclaw/fs-safe", "@openclaw/proc-safe", "sqlite-vec", "ws"]) {
  const manifest = fs.realpathSync(
    path.join(runtimeRoot, "node_modules", packageName, "package.json"),
  );
  const exports = JSON.parse(fs.readFileSync(manifest, "utf8")).exports;
  const pending = [exports];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string" && /\.[cm]?js$/.test(value)) {
      const entry = path
        .relative(runtimeRoot, path.resolve(path.dirname(manifest), value))
        .split(path.sep)
        .join("/");
      if (!moduleEntries.includes(entry)) {
        moduleEntries.push(entry);
      }
    } else if (value && typeof value === "object") {
      pending.push(...Object.values(value));
    }
  }
}
const moduleAliases = {};
const commonJsPackageRoots = [];
for (const name of ["ws", "undici"]) {
  const directory = fs.realpathSync(path.join(runtimeRoot, "node_modules", name));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const entry = path.resolve(directory, manifest.main);
  moduleAliases[name] = entry;
  moduleEntries.push(path.relative(runtimeRoot, entry).split(path.sep).join("/"));
  if (manifest.type !== "module") {
    commonJsPackageRoots.push(directory + path.sep);
  }
  // The Gateway loads ws/lib directly to bypass Bun's smaller built-in adapter.
  if (name === "ws") {
    moduleEntries.push(
      ...runtimeJavaScriptEntries(path.join(directory, "lib")).map((filename) =>
        path
          .relative(runtimeRoot, path.join(directory, "lib", filename))
          .split(path.sep)
          .join("/"),
      ),
    );
  }
}
const runtimeBootstrap = path.join(outputRoot, "standalone-runtime.mjs");
const embeddedPaths = {};
const sourceGraph = sourceEntries
  ? createStandaloneSourceGraph({
      sourceRoot,
      runtimeRoot,
      outputRoot,
      sourceEntries,
      embeddedPaths,
    })
  : undefined;
const nativeFilename = (filename) => {
  const file = sourceGraph?.files.get(filename);
  return file?.relative.startsWith("node_modules/")
    ? path.join(runtimeRoot, file.relative)
    : filename;
};
const sourceGlobals =
  sourceGraph && path.join(runtimeRoot, ".typed-source", "standalone-globals.d.ts");
if (sourceGlobals) {
  fs.mkdirSync(path.dirname(sourceGlobals), { recursive: true });
  fs.writeFileSync(sourceGlobals, createStandaloneSourceGlobals());
}
for (const entry of moduleEntries) {
  sourceGraph?.addEntry(entry);
}
const workers = prepareStandaloneWorkers({
  runtimeRoot,
  outputRoot,
  workerEntries,
  runtimeBootstrap,
  moduleAliases,
  moduleEntries,
  parse,
  sourceWorkerAliases: sourceGraph?.workerAliases(workerEntries),
});
if (sourceGraph) {
  writeStandaloneSourceDeclarations({
    sourceRoot,
    moduleAliases,
    workerThreadsShim: workers.workerThreadsShim,
  });
}
moduleEntries.push(path.relative(runtimeRoot, workers.workerThreadsShim).split(path.sep).join("/"));
const moduleInputs = new Map();
const outputNames = new Map();
for (const entry of new Set(moduleEntries)) {
  const name = path.posix.normalize(`runtime/${entry.replace(/\.[cm]js$/, ".js")}`);
  outputNames.set(name, [...(outputNames.get(name) ?? []), entry]);
}
for (const [name, entries] of outputNames) {
  for (const entry of entries) {
    const source = sourceGraph?.addEntry(entry) ?? path.resolve(runtimeRoot, entry);
    if (entries.length === 1) {
      moduleInputs.set(entry, { source, output: name });
      continue;
    }
    // Conditional .cjs/.mjs siblings otherwise both emit index.js. Keep both contracts.
    const facade = path.join(outputRoot, "standalone-entries", `${entry}.mjs`);
    const ast = parse(fs.readFileSync(source, "utf8"), {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    const hasDefault =
      entry.endsWith(".cjs") ||
      ast.body.some(
        (node) =>
          node.type === "ExportDefaultDeclaration" ||
          node.specifiers?.some((specifier) => specifier.exported?.name === "default"),
      );
    fs.mkdirSync(path.dirname(facade), { recursive: true });
    fs.writeFileSync(
      facade,
      `export * from ${JSON.stringify(source)};\n` +
        (hasDefault ? `export { default } from ${JSON.stringify(source)};\n` : ""),
    );
    moduleInputs.set(entry, {
      source: facade,
      output: path
        .relative(outputRoot, facade)
        .replace(/\.mjs$/, ".js")
        .split(path.sep)
        .join("/"),
    });
  }
}
Object.assign(
  embeddedPaths,
  Object.fromEntries(
    [...moduleInputs].map(([entry, { source, output }]) => [
      entry,
      `/$bunfs/root/${
        sourceGraph ? path.relative(outputRoot, source).split(path.sep).join("/") : output
      }`,
    ]),
  ),
);
const pluginContract = createStandalonePluginContract({ runtimeRoot, plugins, embeddedPaths });
const pluginLoader =
  mode === "aot" && !supportDestination
    ? undefined
    : await stageStandalonePluginLoader({ runtimeRoot, outputRoot, build: Bun.build });
for (const [name, entry] of Object.entries(moduleAliases)) {
  embeddedPaths[name] = embeddedPaths[path.relative(runtimeRoot, entry).split(path.sep).join("/")];
}
const commonJsEntries = [
  ...moduleEntries
    .filter(
      (entry) =>
        entry.endsWith(".cjs") ||
        (entry.endsWith(".js") &&
          commonJsPackageRoots.some((root) => path.resolve(runtimeRoot, entry).startsWith(root))),
    )
    .map((entry) => embeddedPaths[entry]),
  ...Object.keys(moduleAliases).map((name) => embeddedPaths[name]),
  ...native.commonJsEntries.map((entry) => embeddedPaths[entry]),
];
const artifacts = createStandaloneArtifactAdapter({
  runtimeRoot,
  embeddedPaths,
  parse,
});
const metadataSourceOptions = {
  metadataEntries,
  ...(sourceGraph
    ? {
        resolveImport(specifier, importer) {
          const file = sourceGraph.files.get(importer);
          return file
            ? sourceGraph.resolveOriginal(specifier, file.source, file.context.config)
            : path.resolve(path.dirname(importer), specifier);
        },
      }
    : {}),
};
let metadata = createStandaloneMetadataAdapter({
  runtimeRoot,
  embeddedPaths,
  parse,
  ...metadataSourceOptions,
});
const initialMetadataBootstrap = metadata.bootstrap;
const initialEmbeddedPathsExpression = standaloneEmbeddedPathsExpression(embeddedPaths);
const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot, embeddedPaths, pluginLoader });
fs.writeFileSync(
  runtimeBootstrap,
  `import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
const root = path.join(path.dirname(process.execPath), "runtime");
globalThis.__openclawStandaloneRootUrl = pathToFileURL(root + "/").href;
globalThis.__openclawStandaloneBuildInfo = Object.freeze(${JSON.stringify(STANDALONE_BUILD_MARKER)});
${createUnrenderedModuleUrlBootstrap()}
${mode === "aot" ? "globalThis.__zod_globalConfig = { ...globalThis.__zod_globalConfig, jitless: true };" : ""}
const entries = ${initialEmbeddedPathsExpression};
const commonJsEntries = new Set(${JSON.stringify(commonJsEntries)});
function embedded(pathname) {
  pathname = globalThis.__openclawStandaloneOriginalPath?.(pathname) ?? pathname;
  return entries(pathname) ?? entries(path.relative(root, pathname).split(path.sep).join("/"));
}
globalThis.__openclawStandaloneEmbeddedPath = embedded;
${artifacts.bootstrap}
${metadata.bootstrap}
${native.bootstrap}
globalThis.__openclawStandaloneResolve = (parent, specifier, from = parent) => {
  const resolved = globalThis.__openclawStandaloneNativeResolve(from, specifier);
  return resolved === undefined ? import.meta.resolve(specifier, from) : pathToFileURL(resolved).href;
};
globalThis.__openclawStandaloneImport = (parent, specifier, options) => {
  const text = String(specifier);
  let target = globalThis.__openclawStandaloneNativeResolve(parent, text) ?? text;
  if (target.startsWith("file:")) target = fileURLToPath(target);
  else if (target === text && !path.isAbsolute(text) && !text.startsWith("node:") && !text.startsWith("bun:")) {
    target = Bun.resolveSync(text, path.dirname(fileURLToPath(parent)));
  }
  target = embedded(target) ?? target;
  return (options ? import(target, options) : import(target)).then((loaded) =>
    commonJsEntries.has(target) ? { ...loaded.default, ...loaded } : loaded);
};
${requireAdapter.bootstrap}
let resolving = false;
if (isMainThread) Bun.plugin({ name: "openclaw-embedded-modules", setup(build) {
  // Bun checks the filter against the compiled entry before invoking callbacks.
  const filter = new RegExp("^(?!" + RegExp.escape(Bun.main) + "(?![\\\\s\\\\S]))");
  build.onResolve({ filter }, ({path: specifier, importer, kind}) => {
    if (kind === "require-resolve" || resolving || specifier.startsWith("node:") || specifier.startsWith("bun:")) return;
    let target;
    try {
      resolving = true;
      target = globalThis.__openclawStandaloneNativeResolve(importer || path.join(root, "openclaw.mjs"), specifier)
        ?? (specifier.startsWith("file:") ? fileURLToPath(specifier)
        : path.isAbsolute(specifier) ? specifier
        : (() => {
          try { return Bun.resolveSync(specifier, importer ? path.dirname(importer) : root); }
          catch { return Bun.resolveSync(specifier, root); }
        })());
    } catch { return; } finally { resolving = false; }
    const entry = embedded(target);
    if (entry) return {path: entry, namespace: "file"};
  });
}});
if (process.env.OPENCLAW_STANDALONE_TRACE_PRELOAD) {
  await import(process.env.OPENCLAW_STANDALONE_TRACE_PRELOAD);
}
`,
);
const bootstrap = path.join(
  sourceGraph ? path.join(runtimeRoot, ".typed-source") : outputRoot,
  "standalone-entry.mjs",
);
fs.writeFileSync(
  bootstrap,
  createStandaloneEntrySource({ runtimeBootstrap, runtimeRoot, workerEntries }),
);
const audit = process.env.OPENCLAW_STANDALONE_AUDIT_MODULE
  ? await import(pathToFileURL(process.env.OPENCLAW_STANDALONE_AUDIT_MODULE).href)
  : undefined;
const auditSites = [];
const codegen = await createStandaloneCodegenAdapter({
  runtimeRoot,
  outputRoot,
  parse,
  aot: mode === "aot",
  stateRoot: path.join(outputRoot, "build-state", "static-codegen"),
});
const codegenTransforms = [];
const artifactTransforms = [];
const transformedFiles = [];
const external = [
  "chromium-bidi/*",
  "@audio/decode-ape",
  ...(pluginLoader ? [pluginLoader.specifier] : []),
];
const sourceTransforms =
  sourceGraph &&
  createStandaloneSourceTransforms({
    sourceRoot,
    runtimeRoot,
    parse,
    resolveModule(specifier, importer, config) {
      if (/^(?:node:|bun:)/.test(specifier)) {
        return { id: specifier, external: true };
      }
      try {
        return sourceGraph.resolveOriginal(specifier, importer, config);
      } catch (error) {
        if (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") {
          return null;
        }
        throw error;
      }
    },
    emitChunk: sourceGraph.addEmittedChunk,
  });
const sourceEntrypoints = () => [
  ...new Set([
    bootstrap,
    ...[...moduleInputs.values()].map(({ source }) => source),
    ...workers.entrypoints,
    ...(sourceGraph?.roots ?? []),
  ]),
];
const sourceLoads = new Map();
let reuseSourceLoads = false;
const buildOptions = {
  root: outputRoot,
  splitting: true,
  target: "bun",
  // Platform packages can reference other targets' files behind these fixed host guards.
  define: {
    "process.platform": JSON.stringify(process.platform),
    "process.arch": JSON.stringify(process.arch),
  },
  format: "esm",
  // These optional upstream imports are absent from this install, including normal Bun.
  external,
  outdir: path.join(outputRoot, "modules"),
  naming: {
    entry: "[dir]/[name].[ext]",
    chunk: "chunks/[name]-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  },
  metafile: true,
  plugins: [
    {
      name: "openclaw-standalone-paths",
      setup(build) {
        if (sourceGraph) {
          build.onResolve({ filter: /.*/ }, async (args) => {
            const file = sourceGraph.files.get(args.importer);
            if (!file) {
              return sourceGraph.resolve(args);
            }
            const resolved = await sourceTransforms.resolve({
              specifier: args.path,
              importer: file.source,
              config: file.context.config,
            });
            if (!resolved) {
              return undefined;
            }
            if (resolved.external) {
              const embedded = sourceGraph.resolveExternal(
                resolved.id,
                file.source,
                file.context.config,
              );
              if (embedded) {
                return { path: embedded };
              }
              return { path: resolved.id, external: true };
            }
            const filename =
              path.isAbsolute(resolved.id) && fs.existsSync(resolved.id)
                ? sourceGraph.resolveFile(resolved.id, file.context.config, {
                    specifier: args.path,
                    importer: file.source,
                  })
                : sourceGraph.virtual(resolved.id, file.context.config);
            return { path: filename };
          });
        }
        build.onLoad(
          { filter: sourceGraph ? /\.[cm]?[jt]sx?$/ : /\.[cm]?js$/ },
          async ({ path: filename }) => {
            const relative = relativeStandaloneEntry(runtimeRoot, filename);
            if (filename === bootstrap || relative === undefined) {
              return undefined;
            }
            const sourceFile = sourceGraph?.files.get(filename);
            if (sourceFile && reuseSourceLoads) {
              const loaded = sourceLoads.get(filename);
              if (!loaded) {
                throw new Error(`Native compilation requested an undiscovered source: ${filename}`);
              }
              return loaded;
            }
            let contents;
            let loader =
              sourceFile?.loader ?? (sourceGraph ? standaloneSourceLoader(filename) : "js");
            if (sourceFile) {
              const transformed = sourceFile.virtual
                ? await sourceTransforms.load({
                    filename: sourceFile.source,
                    config: sourceFile.context.config,
                  })
                : await sourceTransforms.transform({
                    filename: sourceFile.source,
                    contents: await fs.promises.readFile(sourceFile.source, "utf8"),
                    config: sourceFile.context.config,
                  });
              if (!transformed) {
                throw new Error(`Unloaded source module: ${sourceFile.source}`);
              }
              contents = transformed.contents;
              if (sourceFile.entryRecord?.pluginPlan) {
                contents = rewritePluginNpmRuntimeSpecifiers(
                  sourceFile.entryRecord.pluginPlan,
                  contents,
                );
              }
              loader = transformed.moduleType ?? (sourceFile.virtual ? "js" : loader);
            } else {
              contents = await fs.promises.readFile(filename, "utf8");
            }
            const artifact = artifacts.transform({ filename, contents });
            contents = artifact.contents;
            const metadataResult = metadata.transform({ filename, contents });
            contents = metadataResult.contents;
            if (artifact.count) {
              artifactTransforms.push({ file: relative, count: artifact.count });
            }
            if (metadataResult.count) {
              artifactTransforms.push({ file: relative, metadata: metadataResult.count });
            }
            const adapted = codegen.transform({
              contents,
              filename,
              preserveTypes: loader === "ts" || loader === "tsx",
            });
            contents = adapted.contents;
            if (
              adapted.count ||
              adapted.typeboxAccelerationDisabled ||
              adapted.guardedIntrinsicWrites
            ) {
              codegenTransforms.push({
                file: relative,
                functions: adapted.count,
                guardedIntrinsicWrites: adapted.guardedIntrinsicWrites,
                typeboxAccelerationDisabled: adapted.typeboxAccelerationDisabled,
              });
            }
            if (/worker_threads|["'](?:ws|undici)["']/.test(contents)) {
              contents = workers.rewriteWorkerImports(
                filename,
                contents,
                parse(contents, { ecmaVersion: "latest", sourceType: "module" }),
              );
            }
            // The launcher loops over legacy suffixes. Expose existing candidates to Bun's graph.
            if (relative === "openclaw.mjs") {
              const candidates = [
                ...new Set(
                  [...contents.matchAll(/["'](\.\/dist\/[^"']+\.[cm]?js)["']/g)].map(
                    (match) => match[1],
                  ),
                ),
              ].filter((entry) => fs.existsSync(path.join(runtimeRoot, entry)));
              const choices = candidates
                .map(
                  (entry) =>
                    `specifier === ${JSON.stringify(entry)} ? import(${JSON.stringify(entry)}) : `,
                )
                .join("");
              contents = contents.replaceAll(
                "await import(specifier)",
                `await (${choices}import(new URL(specifier, globalThis.__openclawStandaloneRootUrl).href))`,
              );
            }
            contents = native.transform({ filename: nativeFilename(filename), contents }).contents;
            contents = rewriteStandaloneImports({
              contents,
              filename,
              physicalFilename: sourceFile?.runtimePath
                ? path.join(runtimeRoot, sourceFile.runtimePath)
                : filename,
              resolveModuleUrl: sourceGraph
                ? () => sourceGraph.resolveModuleUrl(filename)
                : undefined,
              runtimeRoot,
              embeddedPaths,
              moduleAliases,
              workerThreadsShim: workers.workerThreadsShim,
              parse,
              preserveTypes: loader === "ts" || loader === "tsx",
            });
            if (audit) {
              const observed = audit.instrumentSource(contents, relative);
              contents = observed.contents;
              auditSites.push(...observed.sites);
            }
            if (sourceGraph && (loader === "ts" || loader === "tsx")) {
              const reference = `/// <reference path=${JSON.stringify(path.relative(path.dirname(filename), sourceGlobals).split(path.sep).join("/"))} />\n`;
              const shebangEnd = contents.startsWith("#!") ? contents.indexOf("\n") : -1;
              contents =
                shebangEnd >= 0
                  ? contents.slice(0, shebangEnd + 1) + reference + contents.slice(shebangEnd + 1)
                  : reference + contents;
            }
            transformedFiles.push(relative);
            sourceGraph?.recordLoaded(filename, contents);
            const loaded = { contents, loader, resolveDir: path.dirname(filename) };
            if (sourceFile) {
              sourceLoads.set(filename, loaded);
            }
            return loaded;
          },
        );
      },
    },
  ],
};
let result;
let discoveredRoots;
let discoverMore;
do {
  if (sourceGraph) {
    for (const entry of moduleEntries) {
      if (moduleInputs.has(entry)) {
        continue;
      }
      const source = path.resolve(runtimeRoot, entry);
      moduleInputs.set(entry, { source, output: `runtime/${entry}` });
      embeddedPaths[entry] =
        `/$bunfs/root/${path.relative(outputRoot, source).split(path.sep).join("/")}`;
    }
    fs.writeFileSync(
      bootstrap,
      createStandaloneEntrySource({
        runtimeBootstrap,
        runtimeRoot,
        workerEntries,
        moduleEntries,
      }),
    );
  }
  discoveredRoots = sourceEntrypoints().length;
  sourceLoads.clear();
  sourceGraph?.loaded.clear();
  result = await Bun.build({ ...buildOptions, entrypoints: sourceEntrypoints() });
  if (!result.success) {
    throw new AggregateError(result.logs, "Standalone bundle failed");
  }
  discoverMore = Boolean(sourceGraph) && sourceEntrypoints().length !== discoveredRoots;
} while (discoverMore);
if (sourceGraph) {
  for (const output of result.outputs) {
    if (/\.[cm]?js$/.test(output.path)) {
      assertNoUnrenderedModuleUrls(await output.text(), output.path);
    }
  }
  // Computed worker URLs use the caller's context, even when it never imported the worker.
  workers.updateSourceWorkerAliases(sourceGraph.workerAliases(workerEntries));
  metadata = createStandaloneMetadataAdapter({
    runtimeRoot,
    embeddedPaths,
    parse,
    ...metadataSourceOptions,
  });
  fs.writeFileSync(
    runtimeBootstrap,
    fs
      .readFileSync(runtimeBootstrap, "utf8")
      .replace(initialMetadataBootstrap, () => metadata.bootstrap),
  );
}
if (!result.success) {
  throw new AggregateError(result.logs, "Standalone bundle failed");
}
fs.writeFileSync(path.join(outputRoot, "metafile.json"), JSON.stringify(result.metafile, null, 2));
fs.writeFileSync(
  path.join(outputRoot, "transformed.json"),
  JSON.stringify(
    transformedFiles.toSorted((a, b) => a.localeCompare(b)),
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(outputRoot, "worker-entries.json"),
  JSON.stringify(workerEntries, null, 2),
);
fs.writeFileSync(
  path.join(outputRoot, "embedded-modules.json"),
  JSON.stringify(embeddedPaths, null, 2),
);
fs.writeFileSync(
  path.join(outputRoot, "codegen-transforms.json"),
  JSON.stringify(codegenTransforms, null, 2),
);
fs.writeFileSync(
  path.join(outputRoot, "codegen-residuals.json"),
  JSON.stringify(codegen.residuals, null, 2),
);
fs.writeFileSync(
  path.join(outputRoot, "artifact-transforms.json"),
  JSON.stringify(artifactTransforms, null, 2),
);
fs.writeFileSync(path.join(outputRoot, "audit-sites.json"), JSON.stringify(auditSites, null, 2));
const compiledEntries = result.outputs
  .filter((output) => output.path.endsWith(".js"))
  .map((output) => output.path);
const nativeResources = native.finalize({
  metafile: result.metafile,
  embeddedPaths,
  resolveFilename: nativeFilename,
});
const nativeModules = describeStandaloneNativeModules({
  runtimeRoot,
  resources: nativeResources.files,
  sqlite: sqlite.manifest,
});
const packageManager = planStandalonePackageManager(runtimeRoot);
const resourcePlan = planStandaloneRuntime(
  runtimeRoot,
  [
    ...nativeResources.files,
    ...sqlite.files,
    ...packageManager.files,
    ...(pluginLoader?.files ?? []),
  ],
  declaredPluginAssets,
  metadata.directories,
);
const wasm =
  mode === "aot"
    ? prepareStandaloneWasm({
        resources: resourcePlan.files,
        outputRoot: path.join(outputRoot, "modules"),
        parse,
      })
    : undefined;
fs.writeFileSync(
  path.join(outputRoot, "native-resources.json"),
  JSON.stringify(nativeResources.files, null, 2),
);
const builtinRequires = requireAdapter.finalize(native.builtinModules);
let nativeTables = 0;
let builtinTables = 0;
for (const filename of compiledEntries) {
  const original = fs.readFileSync(filename, "utf8");
  let contents = original;
  if (contents.includes(builtinRequires.search)) {
    builtinTables += 1;
    contents = contents.replaceAll(builtinRequires.search, builtinRequires.replacement);
  }
  if (contents.includes(nativeResources.bootstrapReplacement.search)) {
    nativeTables += 1;
    contents =
      // Every embedded worker imports this bootstrap before its library loaders.
      (wasm?.registrationPath ? standaloneWasmImport(filename, wasm.registrationPath) : "") +
      contents.replaceAll(
        nativeResources.bootstrapReplacement.search,
        nativeResources.bootstrapReplacement.replacement,
      );
  }
  if (contents !== original) {
    fs.writeFileSync(filename, contents);
  }
}
if (builtinTables === 0) {
  throw new Error("Standalone bundle omitted its built-in module loaders");
}
if (nativeTables === 0) {
  throw new Error("Standalone bundle omitted its native resource resolution table");
}
// Bun preserves CJS -> ESM requires as import.meta.require in split output.
// The second split pass moves callers, so pin those edges to embedded entry names.
const splitRequireEdges = [];
const compiledEntrySet = new Set(compiledEntries);
for (const filename of compiledEntries) {
  let contents = fs.readFileSync(filename, "utf8");
  if (!contents.includes("import.meta.require")) {
    continue;
  }
  const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
  const pending = [ast];
  const edits = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      node.callee.property?.name === "require" &&
      node.callee.object?.type === "MetaProperty"
    ) {
      const argument = node.arguments[0];
      if (
        argument?.type === "Literal" &&
        typeof argument.value === "string" &&
        argument.value.startsWith(".")
      ) {
        const target = path.resolve(path.dirname(filename), argument.value);
        if (compiledEntrySet.has(target)) {
          const relative = path
            .relative(path.join(outputRoot, "modules"), target)
            .split(path.sep)
            .join("/");
          edits.push([argument.start, argument.end, JSON.stringify(`/$bunfs/root/${relative}`)]);
          splitRequireEdges.push({ from: path.relative(outputRoot, filename), to: relative });
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value);
      } else if (value && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
    contents = contents.slice(0, start) + replacement + contents.slice(end);
  }
  if (edits.length) {
    fs.writeFileSync(filename, contents);
  }
}
fs.writeFileSync(
  path.join(outputRoot, "split-require-edges.json"),
  JSON.stringify(splitRequireEdges, null, 2),
);
const mainEntry = path.join(outputRoot, "modules/standalone-entry.js");
const compileRoot = path.join(outputRoot, "modules");
// Shared chunks remain reachable imports; only public entries and pinned CJS targets need roots.
const compileEntries = new Set(
  Object.entries(result.metafile.outputs)
    .filter(([, output]) => output.entryPoint)
    .map(([entry]) => path.resolve(compileRoot, entry))
    .filter((entry) => compiledEntrySet.has(entry)),
);
for (const { to } of splitRequireEdges) {
  compileEntries.add(path.resolve(compileRoot, to));
}
fs.writeFileSync(
  path.join(outputRoot, "compile-entrypoints.json"),
  JSON.stringify(
    [...compileEntries]
      .map((entry) => path.relative(compileRoot, entry))
      .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    null,
    2,
  ),
);
// Shorter relative names keep the full graph below macOS's exec argument limit.
const compileCwd = path.join(compileRoot, "runtime/dist");
const bunIdentity = {
  version: Bun.version,
  revision: compilerIdentity.stdout.trim(),
  commit: Bun.revision,
  executableSha256: await sha256File(process.execPath),
};
const artifactsToPublish = await compileStandaloneArtifacts({
  runtimeRoot,
  outputRoot,
  destination: destinationRoot,
  supportDestination,
  mode,
  compileFlags,
  compileRoot,
  compileCwd,
  mainEntry,
  compiledEntries,
  compileEntries,
  external,
  bunExecutable: process.execPath,
  bun: bunIdentity,
  openclaw: openclawIdentity,
  plugins,
  nativeModules,
  sqlite: sqlite.manifest,
  resourcePlan,
  ...(sourceGraph
    ? {
        async compileAot({ outfile, buildInfo }) {
          const discoveredFileCount = sourceGraph.files.size;
          const sourceBootstrap = fs.readFileSync(runtimeBootstrap, "utf8");
          fs.writeFileSync(
            runtimeBootstrap,
            (wasm?.registrationPath
              ? standaloneWasmImport(runtimeBootstrap, wasm.registrationPath)
              : "") +
              sourceBootstrap
                .replaceAll(JSON.stringify(STANDALONE_BUILD_MARKER), JSON.stringify(buildInfo))
                .replaceAll(builtinRequires.search, builtinRequires.replacement)
                .replace(initialEmbeddedPathsExpression, () =>
                  standaloneEmbeddedPathsExpression(embeddedPaths),
                )
                .replaceAll(
                  nativeResources.bootstrapReplacement.search,
                  nativeResources.bootstrapReplacement.replacement,
                ),
          );
          const nativeEntrypoints = sourceEntrypoints();
          const sourceConfig = path.join(outputRoot, "tsconfig.json");
          fs.writeFileSync(
            sourceConfig,
            JSON.stringify(
              createStandaloneSourceProject({
                sourceRoot,
                runtimeRoot,
                projectFile: sourceConfig,
                entrypoints: nativeEntrypoints,
              }),
            ),
          );
          const { outdir: _outdir, ...sourceBuildOptions } = buildOptions;
          reuseSourceLoads = true;
          try {
            const compiled = await Bun.build({
              ...sourceBuildOptions,
              entrypoints: nativeEntrypoints,
              compile: {
                outfile,
                aot: true,
                ...options.aotCompileOptions,
                autoloadPackageJson: true,
                autoloadDotenv: false,
                autoloadBunfig: false,
              },
            });
            if (!compiled.success) {
              throw new AggregateError(compiled.logs, "Original TypeScript AOT compilation failed");
            }
            for (const log of compiled.logs) {
              console.error(log);
            }
            if (
              sourceGraph.files.size !== discoveredFileCount ||
              sourceEntrypoints().length !== discoveredRoots
            ) {
              throw new Error("Source graph changed after native resource discovery");
            }
            fs.writeFileSync(
              path.join(outputRoot, "source-graph.json"),
              JSON.stringify(sourceGraph.manifest(), null, 2),
            );
          } finally {
            fs.writeFileSync(runtimeBootstrap, sourceBootstrap);
          }
        },
      }
    : {}),
});
const pruning = pruneStandaloneRuntime(resourcePlan);
await publishStandaloneArtifacts({
  artifacts: artifactsToPublish,
  runtimeRoot,
  manifestInputs: {
    bun: bunIdentity,
    openclaw: openclawIdentity,
    plugins,
    pluginContract,
    nativeModules,
    embedded: {
      ...(wasm ? { webAssembly: wasm.assets } : {}),
      workers: workerEntries.length,
      plugins: new Set(
        Object.keys(embeddedPaths)
          .filter((entry) => entry.startsWith("dist/extensions/"))
          .map((entry) => entry.split("/")[2]),
      ).size,
      modules: Object.keys(embeddedPaths).length,
      inlineWorkers: 0,
    },
    pruning,
    sqlite: sqlite.manifest,
    packageManager: packageManager.manifest,
    ...(sourceGraph ? { sourceBuild: sourceGraph.manifest() } : {}),
  },
});
fs.rmSync(outputRoot, { recursive: true });
