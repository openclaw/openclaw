import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeBuildCommit } from "../write-build-info.ts";

export const STANDALONE_USAGE =
  "Usage: bun scripts/build-bun-standalone.mjs <fresh-output-directory> [--bytecode|--compile-aot|--aot-source] [--plugins <id,id,...>] [--support-output <fresh-directory>]\n" +
  "AOT options: --aot-log-type-mismatches, --trim, --trim-locales <locale,...>, --explain[=<report>], " +
  "--no-compile-function-source, --disallow-code-generation-from-strings[=strict]\n" +
  "Default: JIT. AOT is EXPERIMENTAL and requires an AOT-capable Bun.";

/**
 * @typedef {{
 *   aotLogTypeMismatches?: true,
 *   aotExplain?: string[],
 *   trim?: true | { locales: string[] },
 *   functionSource?: false,
 *   disallowCodeGenerationFromStrings?: true | "strict"
 * }} StandaloneAotCompileOptions
 */

/**
 * @param {string[]} args
 * @returns {{ help: true } | {
 *   help?: false,
 *   outputDirectory: string,
 *   mode: "jit" | "bytecode" | "aot",
 *   compileFlags: string[],
 *   aotCompileOptions?: StandaloneAotCompileOptions,
 *   source?: true,
 *   pluginIds?: string[]
 *   supportOutputDirectory?: string
 * }}
 */
export function parseStandaloneArguments(args) {
  const [outputDirectory, ...flags] = args;
  if (args.length === 1 && ["--help", "-h"].includes(outputDirectory)) {
    return { help: true };
  }
  if (!outputDirectory || outputDirectory.startsWith("-")) {
    throw new Error(STANDALONE_USAGE);
  }
  const compileFlags = [];
  /** @type {StandaloneAotCompileOptions} */
  const aotCompileOptions = {};
  const aotFlags = [];
  const locales = [];
  let pluginIds;
  let supportOutputDirectory;
  let source = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--target" || flag.startsWith("--target=")) {
      throw new Error(
        "Standalone builds use the build process's OS, architecture, and native dependencies. AOT cannot cross-compile; run the matching Bun compiler on each target.",
      );
    } else if (flag === "--support-output") {
      const value = flags[++index];
      if (supportOutputDirectory !== undefined || !value || value.startsWith("-")) {
        throw new Error(
          `Specify --support-output once with a fresh directory.\n${STANDALONE_USAGE}`,
        );
      }
      supportOutputDirectory = value;
    } else if (flag === "--plugins") {
      if (pluginIds !== undefined) {
        throw new Error(`Specify --plugins once.\n${STANDALONE_USAGE}`);
      }
      const value = flags[++index];
      if (!value || value.startsWith("-") || value.split(",").some((id) => !id.trim())) {
        throw new Error(
          `--plugins requires a comma-separated list of plugin IDs.\n${STANDALONE_USAGE}`,
        );
      }
      pluginIds = [...new Set(value.split(",").map((id) => id.trim()))];
    } else if (
      ["--bytecode", "--compile-aot", "--aot-source"].includes(flag) &&
      compileFlags.length === 0
    ) {
      source = flag === "--aot-source";
      compileFlags.push(flag === "--bytecode" ? flag : "--aot");
    } else if (flag === "--explain" || flag.startsWith("--explain=")) {
      const report = flag === "--explain" ? "text" : flag.slice("--explain=".length);
      if (!report) {
        throw new Error(`--explain requires a report name after '='.\n${STANDALONE_USAGE}`);
      }
      (aotCompileOptions.aotExplain ??= []).push(report);
      aotFlags.push(flag);
    } else if (flag === "--trim-locales" || flag.startsWith("--trim-locales=")) {
      const value =
        flag === "--trim-locales" ? flags[++index] : flag.slice("--trim-locales=".length);
      if (!value || value.startsWith("-") || value.split(",").some((locale) => !locale.trim())) {
        throw new Error(
          `--trim-locales requires a comma-separated locale list.\n${STANDALONE_USAGE}`,
        );
      }
      const selected = value.split(",").map((locale) => locale.trim());
      locales.push(...selected);
      aotFlags.push(`--trim-locales=${selected.join(",")}`);
    } else if (flag === "--aot-log-type-mismatches" && !aotCompileOptions.aotLogTypeMismatches) {
      aotCompileOptions.aotLogTypeMismatches = true;
      aotFlags.push(flag);
    } else if (flag === "--trim" && !aotCompileOptions.trim) {
      aotCompileOptions.trim = true;
      aotFlags.push(flag);
    } else if (
      flag === "--no-compile-function-source" &&
      aotCompileOptions.functionSource !== false
    ) {
      aotCompileOptions.functionSource = false;
      aotFlags.push(flag);
    } else if (
      [
        "--disallow-code-generation-from-strings",
        "--disallow-code-generation-from-strings=strict",
      ].includes(flag) &&
      !aotCompileOptions.disallowCodeGenerationFromStrings
    ) {
      aotCompileOptions.disallowCodeGenerationFromStrings = flag.endsWith("=strict")
        ? "strict"
        : true;
      aotFlags.push(flag);
    } else {
      throw new Error(
        `Unknown option or repeated build mode: ${flag}. Choose at most one build mode.\n${STANDALONE_USAGE}`,
      );
    }
  }
  const mode =
    compileFlags[0] === "--aot" ? "aot" : compileFlags[0] === "--bytecode" ? "bytecode" : "jit";
  if (aotFlags.length) {
    if (mode !== "aot") {
      throw new Error(
        `${aotFlags[0]} requires --compile-aot or --aot-source.\n${STANDALONE_USAGE}`,
      );
    }
    if (locales.length) {
      if (!aotCompileOptions.trim) {
        throw new Error(`--trim-locales requires --trim.\n${STANDALONE_USAGE}`);
      }
      aotCompileOptions.trim = { locales: [...new Set(locales)] };
    }
    compileFlags.push(...aotFlags);
  }
  if (supportOutputDirectory && (mode !== "aot" || source)) {
    throw new Error(
      "--support-output requires --compile-aot (emitted-JavaScript AOT). " +
        "Build a separate JIT artifact from the same commit when using --aot-source.",
    );
  }
  return {
    outputDirectory,
    mode,
    compileFlags,
    ...(aotFlags.length ? { aotCompileOptions } : {}),
    ...(source ? { source: true } : {}),
    ...(supportOutputDirectory ? { supportOutputDirectory } : {}),
    ...(pluginIds ? { pluginIds } : {}),
  };
}

export function assertStandaloneCompiler(mode, help) {
  if (mode === "aot" && !/(?:^|\s)--aot(?:\s|=|$)/m.test(help)) {
    throw new Error(
      "EXPERIMENTAL AOT builds require a Bun compiler that supports --aot. " +
        "This Bun does not support it. Use the default JIT mode or --bytecode with the production-pinned Bun; " +
        "build an AOT-capable Bun explicitly to experiment with AOT.",
    );
  }
}

export function assertStandalonePlatform(platform, arch = process.arch) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("Build on macOS or Linux; Windows standalone artifacts are not supported yet.");
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(
      "Standalone builds require an arm64 or x64 compiler process on the target host; AOT cannot cross-compile.",
    );
  }
}

export function relativeStandaloneEntry(root, filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) {
    return undefined;
  }
  const relative = path.relative(root, filename);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

export function resolveStandaloneBuildIdentity(buildInfo, packageVersion) {
  if (
    !buildInfo ||
    typeof buildInfo.version !== "string" ||
    !buildInfo.version.trim() ||
    typeof buildInfo.commit !== "string"
  ) {
    throw new Error("Missing standalone runtime identity in dist/build-info.json. Run pnpm build.");
  }
  const version = buildInfo.version.trim();
  let commit;
  try {
    commit = normalizeBuildCommit(buildInfo.commit, "dist/build-info.json commit");
  } catch (error) {
    throw new Error(`${error.message} Run pnpm build.`, { cause: error });
  }
  if (typeof packageVersion !== "string" || version !== packageVersion.trim()) {
    throw new Error(
      "dist/build-info.json version does not match runtime/package.json. Run pnpm build.",
    );
  }
  return { version, commit };
}

function standaloneMacosEntitlements(mode) {
  return {
    ...(mode === "aot" ? {} : { "com.apple.security.cs.allow-jit": true }),
    "com.apple.security.cs.disable-library-validation": true,
  };
}

export async function sha256File(filename) {
  const digest = createHash("sha256");
  for await (const bytes of fs.createReadStream(filename)) {
    digest.update(bytes);
  }
  return digest.digest("hex");
}

function runtimeEntries(root, relative = "") {
  const entries = [];
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) {
      entries.push(...runtimeEntries(root, name));
    } else if (item.isFile() || item.isSymbolicLink()) {
      entries.push({ name, symlink: item.isSymbolicLink() });
    }
  }
  return entries;
}

function assertStandaloneRuntimeLinks(root, entries) {
  const canonicalRoot = fs.realpathSync(root);
  for (const { name, symlink } of entries) {
    if (!symlink) {
      continue;
    }
    const filename = path.join(root, name);
    // Publication moves the staging tree, so even contained absolute links would break.
    if (path.isAbsolute(fs.readlinkSync(filename))) {
      throw new Error(
        `Invalid standalone runtime symlink ${name}: absolute target is not relocatable`,
      );
    }
    let target;
    try {
      target = fs.realpathSync(filename);
    } catch (error) {
      throw new Error(`Invalid standalone runtime symlink ${name}: dangling or unreadable target`, {
        cause: error,
      });
    }
    const relative = path.relative(canonicalRoot, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error(`Invalid standalone runtime symlink ${name}: target is outside runtime/`);
    }
  }
}

/** Tree SHA256 frames sorted POSIX path, kind, and content hash/link target with NULs and LF. */
export async function describeStandaloneRuntime(root) {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  let fileCount = 0;
  let symlinkCount = 0;
  const entries = runtimeEntries(root).toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  assertStandaloneRuntimeLinks(root, entries);
  for (const { name, symlink } of entries) {
    const filename = path.join(root, name);
    if (symlink) {
      digest.update(`${name}\0symlink\0${fs.readlinkSync(filename)}\n`);
      symlinkCount += 1;
    } else {
      digest.update(`${name}\0file\0${await sha256File(filename)}\n`);
      sizeBytes += fs.statSync(filename).size;
      fileCount += 1;
    }
  }
  return { path: "runtime", sizeBytes, sha256: digest.digest("hex"), fileCount, symlinkCount };
}

/**
 * @param {{
 * outputRoot: string,
 * mode: import("../../cli-invocation.mjs").StandaloneBuildInfo["mode"],
 * bun: import("../../cli-invocation.mjs").StandaloneBuildInfo["bun"],
 * openclaw: import("../../cli-invocation.mjs").StandaloneBuildInfo["openclaw"],
 * embedded: {modules: number, plugins: number, workers: number, inlineWorkers: number},
 * plugins: {embedded: string[], omitted: string[]},
 * pluginContract: ReturnType<typeof import("./bun-standalone-plugins.mjs").createStandalonePluginContract>,
 * pruning: {categories: Record<string, {files: number, bytes: number}>, sidecarPlugins: string[], policy?: string, removedFiles?: number, removedBytes?: number, removedSymlinks?: number},
 * sqlite: {version: string, [key: string]: unknown},
 * packageManager?: {name: string, version: string, entrypoint: string, fileCount: number, sizeBytes: number},
 * sourceBuild?: object,
 * build?: import("../../cli-invocation.mjs").StandaloneBuildInfo["build"],
 * nativeModules?: import("../../cli-invocation.mjs").StandaloneBuildInfo["nativeModules"],
 * debug?: {entry: {path: string, sizeBytes: number, sha256: string}, bootstrap: {path: string, sizeBytes: number, sha256: string}, executable: {path: string, sizeBytes: number, sha256: string}, runtime: Awaited<ReturnType<typeof describeStandaloneRuntime>>}
 * }} options
 */
export async function createStandaloneManifest({
  outputRoot,
  mode,
  bun,
  openclaw,
  embedded,
  plugins,
  pluginContract,
  pruning,
  sqlite,
  packageManager,
  sourceBuild,
  build,
  nativeModules,
  debug,
}) {
  const runtime = await describeStandaloneRuntime(path.join(outputRoot, "runtime"));
  const executable = path.join(outputRoot, "openclaw");
  const { categories, sidecarPlugins, ...pruningSummary } = pruning;
  return {
    schemaVersion: 1,
    ...(sourceBuild ? { sourceBuild } : {}),
    mode,
    ...(build ? { build } : {}),
    ...(nativeModules ? { nativeModules } : {}),
    ...(debug ? { debug } : {}),
    target: { platform: process.platform, arch: process.arch },
    bun,
    openclaw,
    executable: {
      path: "openclaw",
      sizeBytes: fs.statSync(executable).size,
      sha256: await sha256File(executable),
    },
    runtime: {
      ...runtime,
      categories,
      sidecarPlugins,
      sqlite,
      ...(packageManager ? { packageManager } : {}),
    },
    embedded,
    plugins: {
      embedded: plugins.embedded.toSorted(),
      omitted: plugins.omitted.toSorted(),
      contract: pluginContract,
    },
    pruning: pruningSummary,
    ...(process.platform === "darwin"
      ? {
          macos: { hardenedRuntime: true, entitlements: standaloneMacosEntitlements(mode) },
        }
      : {}),
  };
}
