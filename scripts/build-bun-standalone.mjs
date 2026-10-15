#!/usr/bin/env bun
// Build a relocatable executable and sidecar from a completed pnpm build.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntimeProcessEntrypoints } from "../src/infra/runtime-process-manifest.ts";
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
  createStandaloneManifest,
  parseStandaloneArguments,
  relativeStandaloneEntry,
  resolveStandaloneBuildIdentity,
  sha256File,
  STANDALONE_USAGE,
} from "./lib/bun-standalone-contract.mjs";
import { createStandaloneEntrySource } from "./lib/bun-standalone-entry.mjs";
import { rewriteStandaloneImports } from "./lib/bun-standalone-imports.mjs";
import { createStandaloneMetadataAdapter } from "./lib/bun-standalone-metadata.mjs";
import { createStandaloneNativeAdapter } from "./lib/bun-standalone-native.mjs";
import { createStandaloneRequireAdapter } from "./lib/bun-standalone-require.mjs";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
  standaloneResourceCategory,
} from "./lib/bun-standalone-sidecar.mjs";
import { copyStandaloneRuntime, STANDALONE_RUNTIME_ROOTS } from "./lib/bun-standalone-snapshot.mjs";
import { stageStandaloneSqlite } from "./lib/bun-standalone-sqlite.mjs";
import {
  discoverStandaloneWorkers,
  prepareStandaloneWorkers,
} from "./lib/bun-standalone-workers.mjs";
import { listPackagedStaticExtensionAssetOutputs } from "./lib/static-extension-assets.mts";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(sourceRoot, "package.json"));
const { parse } = require("acorn");
const options = parseStandaloneArguments(process.argv.slice(2));
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
if (
  STANDALONE_RUNTIME_ROOTS.some((entry) => {
    const relative = path.relative(path.join(sourceRoot, entry), destinationRoot);
    return (
      relative === "" ||
      (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
    );
  })
) {
  throw new Error(`Choose an output directory outside ${STANDALONE_RUNTIME_ROOTS.join(", ")}.`);
}
if (fs.existsSync(destinationRoot)) {
  throw new Error(`Output already exists: ${destinationRoot}. Choose a fresh output directory.`);
}
if (!fs.existsSync(path.join(sourceRoot, "dist/cli-startup-metadata.json"))) {
  throw new Error("Run pnpm build before building a standalone executable.");
}
fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
const outputRoot = fs.mkdtempSync(path.join(path.dirname(destinationRoot), ".standalone-build-"));
const runtimeRoot = path.join(outputRoot, "runtime");
console.log(`Building ${mode} standalone in ${outputRoot}`);

copyStandaloneRuntime(sourceRoot, runtimeRoot);
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
const moduleEntries = runtimeJavaScriptEntries(path.join(runtimeRoot, "dist"))
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
const workerEntries = discoverStandaloneWorkers({
  runtimeRoot,
  moduleEntries,
  runtimeEntrypoints: createRuntimeProcessEntrypoints(import.meta.url),
});
moduleEntries.push(
  ...fs
    .readdirSync(runtimeRoot)
    .filter((entry) => entry.endsWith(".mjs"))
    .toSorted(),
);
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
const workers = prepareStandaloneWorkers({
  runtimeRoot,
  outputRoot,
  workerEntries,
  runtimeBootstrap,
  moduleAliases,
  moduleEntries,
  parse,
});
moduleEntries.push(path.relative(runtimeRoot, workers.workerThreadsShim).split(path.sep).join("/"));
const moduleInputs = new Map();
const outputNames = new Map();
for (const entry of new Set(moduleEntries)) {
  const name = path.posix.normalize(`runtime/${entry.replace(/\.[cm]js$/, ".js")}`);
  outputNames.set(name, [...(outputNames.get(name) ?? []), entry]);
}
for (const [name, entries] of outputNames) {
  for (const entry of entries) {
    const source = path.resolve(runtimeRoot, entry);
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
const embeddedPaths = Object.fromEntries(
  [...moduleInputs].map(([entry, { output }]) => [entry, `/$bunfs/root/${output}`]),
);
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
  buildIdentity: randomUUID(),
});
const metadata = createStandaloneMetadataAdapter({ runtimeRoot, embeddedPaths, parse });
const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot, embeddedPaths });
fs.writeFileSync(
  runtimeBootstrap,
  `import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
const root = path.join(path.dirname(process.execPath), "runtime");
globalThis.__openclawStandaloneRootUrl = pathToFileURL(root + "/").href;
${mode === "aot" ? "globalThis.__zod_globalConfig = { ...globalThis.__zod_globalConfig, jitless: true };" : ""}
const entries = ${JSON.stringify(embeddedPaths)};
const embeddedEntries = new Set(Object.values(entries));
const commonJsEntries = new Set(${JSON.stringify(commonJsEntries)});
function embedded(pathname) {
  pathname = globalThis.__openclawStandaloneOriginalPath?.(pathname) ?? pathname;
  if (embeddedEntries.has(pathname)) return pathname;
  return entries[pathname] ?? entries[path.relative(root, pathname).split(path.sep).join("/")];
}
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
  build.onResolve({ filter: /.*/ }, ({path: specifier, importer, kind}) => {
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
const bootstrap = path.join(outputRoot, "standalone-entry.mjs");
fs.writeFileSync(
  bootstrap,
  createStandaloneEntrySource({ runtimeBootstrap, runtimeRoot, workerEntries, moduleEntries }),
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
const external = ["chromium-bidi/*", "@audio/decode-ape"];
const result = await Bun.build({
  entrypoints: [
    bootstrap,
    ...[...moduleInputs.values()].map(({ source }) => source),
    ...workers.entrypoints,
  ],
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
        build.onLoad({ filter: /\.[cm]?js$/ }, async ({ path: filename }) => {
          const relative = relativeStandaloneEntry(runtimeRoot, filename);
          if (relative === undefined) {
            return undefined;
          }
          let contents = await fs.promises.readFile(filename, "utf8");
          contents = workers.rewriteInlineWorkers(filename, contents);
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
          const adapted = codegen.transform({ contents, filename });
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
          contents = native.transform({ filename, contents }).contents;
          contents = rewriteStandaloneImports({
            contents,
            filename,
            runtimeRoot,
            embeddedPaths,
            moduleAliases,
            workerThreadsShim: workers.workerThreadsShim,
            parse,
          });
          if (audit) {
            const observed = audit.instrumentSource(contents, relative);
            contents = observed.contents;
            auditSites.push(...observed.sites);
          }
          transformedFiles.push(relative);
          return { contents, loader: "js", resolveDir: path.dirname(filename) };
        });
      },
    },
  ],
});
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
  path.join(outputRoot, "inline-worker-entries.json"),
  JSON.stringify(workers.inlineWorkers, null, 2),
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
const nativeResources = native.finalize({ metafile: result.metafile, embeddedPaths });
const resourcePlan = planStandaloneRuntime(
  runtimeRoot,
  [...nativeResources.files, ...sqlite.files],
  declaredPluginAssets,
  metadata.directories,
);
fs.writeFileSync(
  path.join(outputRoot, "native-resources.json"),
  JSON.stringify(nativeResources.files, null, 2),
);
let nativeTables = 0;
for (const filename of compiledEntries) {
  const contents = fs.readFileSync(filename, "utf8");
  if (contents.includes(nativeResources.bootstrapReplacement.search)) {
    nativeTables += 1;
    fs.writeFileSync(
      filename,
      contents.replaceAll(
        nativeResources.bootstrapReplacement.search,
        nativeResources.bootstrapReplacement.replacement,
      ),
    );
  }
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
const executable = path.join(outputRoot, "openclaw");
const compiled = spawnSync(
  process.execPath,
  [
    "build",
    "--compile",
    "--splitting",
    "--format=esm",
    `--root=${compileRoot}`,
    "--compile-autoload-package-json",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...compileFlags,
    ...external.map((specifier) => `--external=${specifier}`),
    path.relative(compileCwd, mainEntry),
    ...compiledEntries
      .filter((entry) => entry !== mainEntry && compileEntries.has(entry))
      .map((entry) => path.relative(compileCwd, entry)),
    `--outfile=${executable}`,
  ],
  { stdio: "inherit", cwd: compileCwd },
);
if (compiled.status !== 0) {
  throw new Error(`Standalone compilation failed (${compiled.status})`);
}
const pruning = pruneStandaloneRuntime(resourcePlan);
const manifest = await createStandaloneManifest({
  outputRoot,
  mode,
  bun: {
    version: Bun.version,
    revision: compilerIdentity.stdout.trim(),
    commit: Bun.revision,
    executableSha256: await sha256File(process.execPath),
  },
  openclaw: openclawIdentity,
  embedded: {
    workers: workerEntries.length,
    plugins: new Set(
      Object.keys(embeddedPaths)
        .filter((entry) => entry.startsWith("dist/extensions/"))
        .map((entry) => entry.split("/")[2]),
    ).size,
    modules: Object.keys(embeddedPaths).length,
    inlineWorkers: workers.inlineWorkers.length,
  },
  pruning,
  sqlite: sqlite.manifest,
});
fs.mkdirSync(destinationRoot);
fs.renameSync(executable, path.join(destinationRoot, "openclaw"));
fs.renameSync(runtimeRoot, path.join(destinationRoot, "runtime"));
fs.writeFileSync(
  path.join(destinationRoot, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
fs.rmSync(outputRoot, { recursive: true });
console.log(`Standalone ready: ${path.join(destinationRoot, "openclaw")}`);
