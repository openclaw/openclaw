#!/usr/bin/env node
// The build records its authoritative output plan; finished distributions only verify it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertArtifactTreeReadable,
  declaredArtifactExecutableFiles,
  ensureGeneratedArtifactDirectory,
  normalizeGeneratedArtifactTree,
} from "../src/shared/artifact-permissions.ts";

type PluginPlan = {
  id: string;
  root: string;
  requiredFiles: string[];
  controlUi?: { entry: string; styles?: string[] };
};
type ArtifactPlan = {
  schemaVersion: 1;
  sourceSha?: string;
  requireUi: boolean;
  staticAssets: boolean;
  requiredFiles: string[];
  sourceRequiredFiles: string[];
  executableFiles: string[];
  generatedRoots: string[];
  plugins: PluginPlan[];
};
type BuildParams = { rootDir?: string; requireUi?: boolean; env?: NodeJS.ProcessEnv };
type CheckParams = BuildParams & {
  image?: boolean;
  readFiles?: boolean;
  legacySource?: boolean;
  sourceSha?: string;
};
const PLAN = "dist/runtime-artifact-plan.json";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an artifact metadata object");
  }
  return value as Record<string, unknown>;
}
function json(file: string) {
  return object(JSON.parse(fs.readFileSync(file, "utf8")));
}
function relative(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error(`Invalid artifact-relative path: ${String(value)}`);
  }
  const result = value.replace(/^\.\//u, "");
  if (result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid artifact-relative path: ${value}`);
  }
  return result;
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Artifact paths must be an array");
  }
  return value.map(relative);
}
function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted();
}
function sourceSha(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  if (value && !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new Error("Artifact source SHA must be a full 40-character hexadecimal SHA");
  }
  return value?.toLowerCase();
}
function readPlan(root: string): ArtifactPlan {
  const raw = json(path.join(root, PLAN));
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.requireUi !== "boolean" ||
    typeof raw.staticAssets !== "boolean" ||
    !Array.isArray(raw.plugins)
  ) {
    throw new Error("Unsupported runtime artifact plan");
  }
  const plugins = raw.plugins.map((value) => {
    const plugin = object(value);
    if (typeof plugin.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(plugin.id)) {
      throw new Error("Invalid artifact plugin ID");
    }
    const pluginRoot = relative(plugin.root);
    if (pluginRoot !== `dist/extensions/${plugin.id}`) {
      throw new Error("Plugin artifact root does not match its ID");
    }
    let controlUi: PluginPlan["controlUi"];
    if (plugin.controlUi !== undefined) {
      const ui = object(plugin.controlUi);
      controlUi = {
        entry: relative(ui.entry),
        ...(ui.styles === undefined ? {} : { styles: paths(ui.styles) }),
      };
    }
    return {
      id: plugin.id,
      root: pluginRoot,
      requiredFiles: paths(plugin.requiredFiles),
      ...(controlUi ? { controlUi } : {}),
    };
  });
  if (new Set(plugins.map(({ id }) => id)).size !== plugins.length) {
    throw new Error("Duplicate artifact plugin IDs");
  }
  if (raw.sourceSha !== undefined && typeof raw.sourceSha !== "string") {
    throw new Error("Artifact source SHA must be a string");
  }
  const sha = raw.sourceSha === undefined ? undefined : sourceSha({ GIT_COMMIT: raw.sourceSha });
  return {
    schemaVersion: 1,
    ...(sha ? { sourceSha: sha } : {}),
    requireUi: raw.requireUi,
    staticAssets: raw.staticAssets,
    requiredFiles: paths(raw.requiredFiles),
    sourceRequiredFiles: paths(raw.sourceRequiredFiles),
    executableFiles: paths(raw.executableFiles),
    generatedRoots: paths(raw.generatedRoots),
    plugins,
  };
}

/** Config evaluation uses the same cwd, selectors, and TS loader as the compiler. */
function compiledOutputPlan(root: string, env: NodeJS.ProcessEnv): string[] {
  const loader = new URL("./tsx.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      loader,
      "--input-type=module",
      "--eval",
      `
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const files=[];
for(const file of ["tsdown.config.ts","tsdown.ai.config.ts"]){
 if(!fs.existsSync(file))continue;
 const loaded=(await import(pathToFileURL(path.resolve(file)).href)).default;
 for(const config of Array.isArray(loaded)?loaded:[loaded]){
  if(config.dts && typeof config.dts==="object" && config.dts.emitDtsOnly)continue;
  const extension=config.outExtensions?.({format:"esm"})?.js ?? ".mjs";
  const entries=typeof config.entry==="string" ? {[path.basename(config.entry,path.extname(config.entry))]:config.entry} : config.entry;
  if(!entries || Array.isArray(entries))throw new Error("Unsupported compiler entry inventory");
  for(const name of Object.keys(entries)){
   const entryFileNames=config.outputOptions?.entryFileNames;
   const pattern=typeof entryFileNames==="function" ? entryFileNames({name}) : entryFileNames ?? "[name]"+extension;
   const output=path.posix.join(config.outDir??"dist",pattern.replaceAll("[name]",name).replaceAll("[extname]",extension));
   if(output.includes("["))throw new Error("Cannot predict compiler entry output: "+output);
   // Worker deployment packages ship sealed archives, not their raw build roots.
   if((output.startsWith("dist/") && !output.startsWith("dist/worker/")) || output.startsWith("packages/"))files.push(output);
  }
 }
}
if(!files.length)throw new Error("Compiler emitted no root output inventory");
process.stdout.write(JSON.stringify([...new Set(files)].toSorted()));
`,
    ],
    {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Cannot derive compiler artifact plan: ${result.stderr || result.error?.message}`,
    );
  }
  return paths(JSON.parse(result.stdout));
}

async function createSourcePlan(root: string, params: BuildParams): Promise<ArtifactPlan> {
  const env = params.env ?? process.env;
  const { collectSourceCheckoutPluginBuildEntries } =
    await import("./lib/bundled-plugin-build-entries.mjs");
  const {
    listGeneratedExtensionAssetSources,
    resolvePackageStaticAssetEntries,
    shouldCopyStaticExtensionAssets,
  } = await import("./lib/static-extension-assets.mts");
  const { TSDOWN_PACKAGE_OUTPUT_ROOTS } = await import("./lib/tsdown-output-roots.mts");
  const { collectPluginThemeAssetPaths } = await import("./lib/plugin-theme-assets.mts");
  const { PORTABLE_PLUGIN_ICON_PATH, PLUGIN_ACTIVITY_ICON_PATH, PLUGIN_TOOL_ACTIVITY_ICON_DIR } =
    await import("../src/plugins/portable-icon-paths.ts");
  const compiled = compiledOutputPlan(root, env);
  const staticAssets = shouldCopyStaticExtensionAssets({ env });
  const requiredFiles = new Set(compiled.filter((file) => file.startsWith("dist/")));
  const sourceRequiredFiles = compiled.filter((file) => file.startsWith("packages/"));
  const executableFiles = new Set<string>();
  const plugins: PluginPlan[] = [];
  const rootManifest = json(path.join(root, "package.json"));
  const runtimeDependencies = new Set([
    ...Object.keys(
      rootManifest.dependencies === undefined ? {} : object(rootManifest.dependencies),
    ),
    ...Object.keys(
      rootManifest.optionalDependencies === undefined
        ? {}
        : object(rootManifest.optionalDependencies),
    ),
  ]);
  for (const file of sourceRequiredFiles) {
    const [, packageName, ...output] = file.split("/");
    const manifest = json(path.join(root, "packages", packageName!, "package.json"));
    if (typeof manifest.name === "string" && runtimeDependencies.has(manifest.name)) {
      requiredFiles.add(`node_modules/${manifest.name}/${output.join("/")}`);
    }
  }
  for (const file of declaredArtifactExecutableFiles(rootManifest)) {
    executableFiles.add(file);
  }
  for (const entry of collectSourceCheckoutPluginBuildEntries({ cwd: root, env })) {
    const pluginRoot = `dist/extensions/${entry.id}`;
    const sourceRoot = path.join(root, "extensions", entry.id);
    const manifest = entry.hasManifest
      ? json(path.join(sourceRoot, "openclaw.plugin.json"))
      : undefined;
    const files = entry.sourceEntries.map(
      (file: string) =>
        `${pluginRoot}/${relative(file).replace(/\.[^.]+$/u, entry.runtimeExtension)}`,
    );
    if (entry.hasManifest) {
      files.push(`${pluginRoot}/openclaw.plugin.json`);
    }
    if (entry.hasPackageJson) {
      files.push(`${pluginRoot}/package.json`);
    }
    let controlUi: PluginPlan["controlUi"];
    if (manifest?.controlUi !== undefined) {
      const ui = object(manifest.controlUi);
      controlUi = {
        entry: relative(ui.entry),
        ...(ui.styles === undefined ? {} : { styles: paths(ui.styles) }),
      };
      if (staticAssets) {
        files.push(
          `${pluginRoot}/${controlUi.entry}`,
          ...(controlUi.styles ?? []).map((file) => `${pluginRoot}/${file}`),
        );
      }
    }
    for (const asset of [
      "README.md",
      PORTABLE_PLUGIN_ICON_PATH,
      PLUGIN_ACTIVITY_ICON_PATH,
      ...collectPluginThemeAssetPaths(manifest ?? {}),
    ]) {
      if (fs.lstatSync(path.join(sourceRoot, asset), { throwIfNoEntry: false })?.isFile()) {
        files.push(`${pluginRoot}/${relative(asset)}`);
      }
    }
    const toolIcons = path.join(sourceRoot, PLUGIN_TOOL_ACTIVITY_ICON_DIR);
    if (fs.lstatSync(toolIcons, { throwIfNoEntry: false })?.isDirectory()) {
      for (const icon of fs.readdirSync(toolIcons, { withFileTypes: true })) {
        if (icon.isFile() && icon.name.endsWith(".svg")) {
          files.push(`${pluginRoot}/${PLUGIN_TOOL_ACTIVITY_ICON_DIR}/${icon.name}`);
        }
      }
    }
    if (staticAssets) {
      for (const asset of resolvePackageStaticAssetEntries(entry.packageJson ?? {})) {
        files.push(`${pluginRoot}/${relative(asset.output)}`);
      }
    }
    for (const file of declaredArtifactExecutableFiles(entry.packageJson ?? {})) {
      executableFiles.add(`${pluginRoot}/${file}`);
    }
    for (const file of files) {
      requiredFiles.add(file);
      sourceRequiredFiles.push(file.replace(/^dist\/extensions\//u, "dist-runtime/extensions/"));
    }
    plugins.push({
      id: entry.id,
      root: pluginRoot,
      requiredFiles: unique(files),
      ...(controlUi ? { controlUi } : {}),
    });
  }
  const generatedRoots = new Set(["dist", "dist-runtime"]);
  for (const output of TSDOWN_PACKAGE_OUTPUT_ROOTS) {
    if (fs.existsSync(path.join(root, output))) {
      generatedRoots.add(output);
    }
  }
  const selectedPlugins = new Set(plugins.map(({ id }) => id));
  // Metadata publication retires unselected plugin directories even if a
  // private compiler harness emitted an extra plugin-owned entry first.
  for (const file of requiredFiles) {
    if (file.startsWith("dist/extensions/") && !selectedPlugins.has(file.split("/")[2]!)) {
      requiredFiles.delete(file);
    }
  }
  for (const output of staticAssets
    ? listGeneratedExtensionAssetSources({ rootDir: root, env })
    : []) {
    if (selectedPlugins.has(output.split("/")[1]!) && fs.existsSync(path.join(root, output))) {
      generatedRoots.add(relative(output));
    }
  }
  const identity =
    sourceSha(env) ??
    (() => {
      const result = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return result.status === 0 ? sourceSha({ GIT_COMMIT: result.stdout.trim() }) : undefined;
    })();
  const sha = identity;
  return {
    schemaVersion: 1,
    ...(sha ? { sourceSha: sha } : {}),
    requireUi: params.requireUi ?? false,
    staticAssets,
    requiredFiles: unique(requiredFiles),
    sourceRequiredFiles: unique(sourceRequiredFiles),
    executableFiles: unique(executableFiles),
    generatedRoots: unique(generatedRoots),
    plugins,
  };
}

/** Only writer-owned outputs change; private source roots and dependencies do not. */
export async function normalizeBuildArtifactPermissions(params: BuildParams = {}) {
  const root = fs.realpathSync(params.rootDir ?? process.cwd());
  const plan = await createSourcePlan(root, params);
  ensureGeneratedArtifactDirectory(path.join(root, "dist"), root);
  for (const output of plan.generatedRoots) {
    const target = path.join(root, output);
    if (!fs.existsSync(target)) {
      continue;
    }
    const owner =
      output.startsWith("extensions/") || output.startsWith("packages/")
        ? path.join(root, ...output.split("/").slice(0, 2))
        : root;
    ensureGeneratedArtifactDirectory(
      fs.statSync(target).isDirectory() ? target : path.dirname(target),
      owner,
    );
    const executables = plan.executableFiles
      .filter((file) => file.startsWith(`${output}/`))
      .map((file) => file.slice(output.length + 1));
    normalizeGeneratedArtifactTree(target, {
      allowLinksWithin: root,
      executableFiles: executables,
    });
  }
  // Metadata from a previous source/cache generation is replaced by the current
  // compiler's plan, never inferred from whatever output happens to survive.
  const planPath = path.join(root, PLAN);
  const oldPlan = fs.lstatSync(planPath, { throwIfNoEntry: false });
  if (oldPlan && (!oldPlan.isFile() || oldPlan.nlink > 1)) {
    throw new Error("Artifact plan must be a private regular generated file");
  }
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o644 });
  fs.chmodSync(planPath, 0o644);
  return plan;
}

function requireFiles(root: string, files: string[]) {
  for (const file of files) {
    const target = path.join(root, file);
    if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing required runtime artifact: ${file}`);
    }
    if (!fs.realpathSync(target).startsWith(`${root}${path.sep}`)) {
      throw new Error(`Runtime artifact escapes distribution: ${file}`);
    }
  }
}
function validateSourceIdentity(root: string, plan: ArtifactPlan, env: NodeJS.ProcessEnv) {
  const expected = sourceSha(env);
  if (expected && plan.sourceSha !== expected) {
    throw new Error("Runtime artifact plan does not match source SHA");
  }
  const buildInfo = path.join(root, "dist/build-info.json");
  if (fs.existsSync(buildInfo)) {
    const info = json(buildInfo);
    const commit = info.commit;
    if (
      typeof commit === "string" &&
      /^[a-f0-9]{40}$/iu.test(commit) &&
      plan.sourceSha &&
      commit.toLowerCase() !== plan.sourceSha
    ) {
      throw new Error("Runtime artifact plan does not match build provenance");
    }
  }
}
function retainedExecutables(root: string): string[] {
  const files = new Set<string>();
  const visited = new Set<string>();
  const visit = (directory: string) => {
    const real = fs.realpathSync(directory);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Dependency escapes immutable image: ${directory}`);
    }
    if (visited.has(real)) {
      return;
    }
    visited.add(real);
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      const file = path.join(real, entry.name);
      const relativeRoot = path.relative(root, real).replaceAll(path.sep, "/");
      const parent = path.dirname(real);
      const packageRoot =
        real === root ||
        /^packages\/[^/]+$/u.test(relativeRoot) ||
        /^(?:dist\/)?extensions\/[^/]+$/u.test(relativeRoot) ||
        path.basename(parent) === "node_modules" ||
        (path.basename(parent).startsWith("@") &&
          path.basename(path.dirname(parent)) === "node_modules");
      if (entry.name === "package.json" && entry.isFile() && packageRoot) {
        for (const executable of declaredArtifactExecutableFiles(json(file))) {
          files.add(path.relative(root, path.join(real, executable)).replaceAll(path.sep, "/"));
        }
      } else if (
        entry.isDirectory() ||
        (entry.isSymbolicLink() && fs.statSync(file).isDirectory())
      ) {
        visit(file);
      }
    }
  };
  visit(root);
  return unique(files);
}

/** Read-only acceptance; a final image must not repair itself while being tested. */
export function assertBuiltArtifactPermissions(params: CheckParams = {}) {
  const root = fs.realpathSync(params.rootDir ?? process.cwd());
  const planPath = path.join(root, PLAN);
  let plan: ArtifactPlan;
  let planState: "verified" | "legacy-source" = "verified";
  if (!fs.existsSync(planPath) && params.legacySource) {
    planState = "legacy-source";
    plan = {
      schemaVersion: 1,
      requireUi: true,
      staticAssets: true,
      requiredFiles: ["dist/entry.js"],
      sourceRequiredFiles: [],
      executableFiles: [],
      generatedRoots: ["dist"],
      plugins: [],
    };
  } else {
    if (!fs.lstatSync(planPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("Missing regular source-derived runtime artifact plan");
    }
    plan = readPlan(root);
  }
  // Historical artifacts have no source-derived inventory to bind. Their explicit
  // legacy-source result must not claim current inventory/provenance guarantees.
  if (planState === "verified") {
    validateSourceIdentity(root, plan, params.env ?? process.env);
  }
  const expectedSha =
    params.sourceSha === undefined ? undefined : sourceSha({ GIT_COMMIT: params.sourceSha });
  if (params.sourceSha !== undefined && !expectedSha) {
    throw new Error("Expected source SHA cannot be empty");
  }
  if (expectedSha && plan.sourceSha !== expectedSha && planState !== "legacy-source") {
    throw new Error("Runtime artifact plan does not match expected source SHA");
  }
  if (params.image && !plan.staticAssets) {
    throw new Error("Image acceptance requires a complete static asset build contract");
  }
  requireFiles(root, [
    ...plan.requiredFiles,
    ...plan.plugins.flatMap((plugin) => plugin.requiredFiles),
    ...(!params.image ? plan.sourceRequiredFiles : []),
  ]);
  if (planState === "verified") {
    const extensionRoot = path.join(root, "dist/extensions");
    const installed = fs.existsSync(extensionRoot)
      ? fs
          .readdirSync(extensionRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
          .map((entry) => entry.name)
          .toSorted()
      : [];
    if (JSON.stringify(installed) !== JSON.stringify(plan.plugins.map(({ id }) => id).toSorted())) {
      throw new Error("Finished bundled plugin membership differs from the source artifact plan");
    }
  }
  for (const plugin of plan.plugins) {
    if (!plugin.controlUi) {
      continue;
    }
    const manifest = json(path.join(root, plugin.root, "openclaw.plugin.json"));
    const ui = object(manifest.controlUi);
    const retained = {
      entry: relative(ui.entry),
      ...(ui.styles === undefined ? {} : { styles: paths(ui.styles) }),
    };
    if (JSON.stringify(retained) !== JSON.stringify(plugin.controlUi)) {
      throw new Error(`Plugin UI metadata differs from the source artifact plan: ${plugin.id}`);
    }
  }
  if (params.image || params.requireUi || plan.requireUi) {
    requireFiles(root, ["dist/control-ui/index.html"]);
  }
  let files = 0;
  let directories = 0;
  if (params.image) {
    const result = assertArtifactTreeReadable(root, {
      allowLinksWithin: root,
      executableFiles: unique([...plan.executableFiles, ...retainedExecutables(root)]),
      readFiles: params.readFiles,
    });
    files = result.files;
    directories = result.directories;
  } else {
    for (const output of plan.generatedRoots) {
      const target = path.join(root, output);
      if (!fs.existsSync(target)) {
        continue;
      }
      const owner =
        output.startsWith("extensions/") || output.startsWith("packages/")
          ? path.join(root, ...output.split("/").slice(0, 2))
          : root;
      const result = assertArtifactTreeReadable(target, {
        allowLinksWithin: root,
        resolveLinks: false,
        ownerRoot: owner,
        executableFiles: plan.executableFiles
          .filter((file) => file.startsWith(`${output}/`))
          .map((file) => file.slice(output.length + 1)),
        readFiles: params.readFiles,
      });
      files += result.files;
      directories += result.directories;
    }
  }
  if (files === 0 || directories === 0) {
    throw new Error("Artifact acceptance inspected no runtime files/directories");
  }
  return {
    schemaVersion: 1,
    ...(plan.sourceSha ? { sourceSha: plan.sourceSha } : {}),
    readFiles: params.readFiles === true,
    files,
    directories,
    plugins: plan.plugins.length,
    planState,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = process.argv.slice(2);
    const rootIndex = args.indexOf("--root");
    const known = new Set([
      "--root",
      "--source-sha",
      "--image",
      "--read-files",
      "--legacy-source",
      "--normalize",
      "--write-plan",
    ]);
    for (let index = 0; index < args.length; index++) {
      if (!known.has(args[index]!)) {
        throw new Error(`Unknown artifact checker argument: ${args[index]}`);
      }
      if (args[index] === "--root" || args[index] === "--source-sha") {
        if (!args[++index] || args[index]!.startsWith("--")) {
          throw new Error("Artifact option requires a value");
        }
      }
    }
    const sourceIndex = args.indexOf("--source-sha");
    const params = {
      sourceSha: sourceIndex === -1 ? undefined : args[sourceIndex + 1],
      rootDir: rootIndex === -1 ? undefined : args[rootIndex + 1],
      image: args.includes("--image"),
      readFiles: args.includes("--read-files"),
      legacySource: args.includes("--legacy-source"),
    };
    if (args.includes("--normalize") || args.includes("--write-plan")) {
      if (params.image || params.legacySource) {
        throw new Error("Image and legacy acceptance are read-only");
      }
      await normalizeBuildArtifactPermissions(params);
    }
    console.log(JSON.stringify(assertBuiltArtifactPermissions(params)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
