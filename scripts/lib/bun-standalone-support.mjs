import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createStandaloneManifest,
  describeStandaloneRuntime,
  sha256File,
} from "./bun-standalone-contract.mjs";

/** @typedef {import("../../cli-invocation.mjs").StandaloneBuildInfo} BuildInfo */
/** @typedef {NonNullable<BuildInfo["nativeModules"]>} NativeModules */
/** @typedef {{mode: BuildInfo["mode"], flavor: "standard" | "support", destination: string, outputRoot: string, compileFlags: string[]}} Artifact */
/** @typedef {Artifact & {build: NonNullable<BuildInfo["build"]>}} CompiledArtifact */

/** @param {string[]} pluginIds */
function standalonePluginSetSha256(pluginIds) {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(pluginIds)].toSorted()))
    .digest("hex");
}

/** @param {string} root @param {string[]} entries */
export function standaloneModuleGraphSha256(root, entries) {
  const digest = createHash("sha256");
  for (const filename of [...new Set(entries)].toSorted()) {
    digest.update(path.relative(root, filename).split(path.sep).join("/") + "\0");
    digest.update(fs.readFileSync(filename));
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** @param {string[]} destinations */
export function assertStandaloneDestinations(destinations) {
  for (const [index, destination] of destinations.entries()) {
    if (fs.existsSync(destination)) {
      throw new Error(`Output already exists: ${destination}. Choose a fresh output directory.`);
    }
    for (const other of destinations.slice(index + 1)) {
      const relative = path.relative(destination, other);
      const inverse = path.relative(other, destination);
      if (
        !relative ||
        !inverse ||
        (!relative.startsWith(".." + path.sep) &&
          relative !== ".." &&
          !path.isAbsolute(relative)) ||
        (!inverse.startsWith(".." + path.sep) && inverse !== ".." && !path.isAbsolute(inverse))
      ) {
        throw new Error(
          "Standalone and support output directories must be separate, non-nested directories.",
        );
      }
    }
  }
}

/**
 * Native-resource selection already filters binary headers by target. Record that
 * inventory without loading addons or mistaking successful packaging for runtime proof.
 * @param {{runtimeRoot: string, resources: {source: string, destination: string, category: string}[], sqlite: {version: string}}} options
 * @returns {NativeModules}
 */
export function describeStandaloneNativeModules({ runtimeRoot, resources, sqlite }) {
  const nativeFiles = resources.filter((file) =>
    ["nativeAddons", "nativeLibraries"].includes(file.category),
  );
  /** @type {NativeModules} */
  const modules = [
    {
      name: "sqlite",
      version: sqlite.version,
      artifacts: [],
      qualification: "unverified",
      backend: "sqlite",
    },
  ];
  for (const metadata of resources.filter((file) => file.category === "dependencyMetadata")) {
    const directory = path.posix.dirname(metadata.destination) + "/";
    const artifacts = nativeFiles
      .filter((file) => file.destination.startsWith(directory))
      .map((file) => file.destination)
      .toSorted();
    if (!artifacts.length) {
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, metadata.source), "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Native package metadata is missing name/version: ${metadata.source}`);
    }
    modules.push({
      name: manifest.name,
      version: manifest.version,
      artifacts,
      qualification: "unverified",
      backend: "runtime-selected",
    });
  }
  return modules.toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

export const STANDALONE_BUILD_MARKER = "__OPENCLAW_STANDALONE_BUILD_INFO__";

/**
 * Flavor stamps are the sole intentional difference in the staged module graph.
 * @param {string[]} entries @param {unknown} buildInfo
 */
function stampStandaloneBuild(entries, buildInfo) {
  const marker = JSON.stringify(STANDALONE_BUILD_MARKER);
  /** @type {Map<string, string>} */
  const originals = new Map();
  for (const filename of entries) {
    const source = fs.readFileSync(filename, "utf8");
    if (!source.includes(marker)) {
      continue;
    }
    originals.set(filename, source);
    fs.writeFileSync(filename, source.replaceAll(marker, JSON.stringify(buildInfo)));
  }
  if (!originals.size) {
    throw new Error("Standalone bundle omitted its build identity.");
  }
  return () => {
    for (const [filename, source] of originals) {
      fs.writeFileSync(filename, source);
    }
  };
}

function stageSupportRuntime({ runtimeRoot, outputRoot, bunExecutable, omittedDirs }) {
  const debugRoot = path.join(outputRoot, "debug");
  const runtime = path.join(debugRoot, "runtime");
  fs.cpSync(runtimeRoot, runtime, {
    recursive: true,
    verbatimSymlinks: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter(source) {
      if (!fs.lstatSync(source).isSymbolicLink() || fs.existsSync(source)) {
        return true;
      }
      // Selecting plugins removes their workspace directories; omit only those dangling aliases.
      const target = path.resolve(path.dirname(source), fs.readlinkSync(source));
      const relative = path.relative(runtimeRoot, target).split(path.sep).join("/");
      if (
        omittedDirs.some((directory) =>
          ["extensions/", "dist/extensions/"].some(
            (parent) =>
              relative === parent + directory || relative.startsWith(parent + directory + "/"),
          ),
        )
      ) {
        return false;
      }
      throw new Error(`Support runtime has a dangling symlink: ${source}`);
    },
  });
  const executable = path.join(debugRoot, "bin/bun");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.copyFileSync(bunExecutable, executable, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(executable, fs.statSync(bunExecutable).mode & 0o777);
}

/**
 * Compile both flavors from one frozen module graph before publishing either.
 * @param {{runtimeRoot: string, outputRoot: string, destination: string, supportDestination?: string, mode: BuildInfo["mode"], compileFlags: string[],
 * aotCompileOptions?: import("./bun-standalone-contract.mjs").StandaloneAotCompileOptions,
 * compileRoot: string, compileCwd: string, mainEntry: string, compiledEntries: string[], compileEntries: Set<string>, external: string[],
 * bunExecutable: string, bun: BuildInfo["bun"], openclaw: BuildInfo["openclaw"], plugins: NonNullable<BuildInfo["plugins"]> & {omittedDirs: string[]},
 * nativeModules: NativeModules, sqlite: {path?: string},
 * resourcePlan: {files: {source: string, destination: string}[], directories: Iterable<string>}, sourceGraphSha256?: string,
 * compileAot?: (options: {outfile: string, buildInfo: object}) => Promise<void>}} options
 * @returns {Promise<CompiledArtifact[]>}
 */
export async function compileStandaloneArtifacts({
  runtimeRoot,
  outputRoot,
  destination,
  supportDestination,
  mode,
  compileFlags,
  aotCompileOptions,
  compileRoot,
  compileCwd,
  mainEntry,
  compiledEntries,
  compileEntries,
  external,
  bunExecutable,
  bun,
  openclaw,
  plugins,
  nativeModules,
  sqlite,
  resourcePlan,
  sourceGraphSha256,
  compileAot,
}) {
  const provenance = {
    pluginSetSha256: standalonePluginSetSha256(plugins.embedded),
    moduleGraphSha256: standaloneModuleGraphSha256(compileRoot, compiledEntries),
  };
  const resources = [];
  for (const { source, destination: name } of resourcePlan.files.toSorted((a, b) =>
    a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0,
  )) {
    resources.push({
      name,
      mode: fs.statSync(source).mode & 0o777,
      sha256: await sha256File(source),
    });
  }
  // Hash the unstamped graph once; both flavors share this immutable identity.
  const id = createHash("sha256")
    .update("openclaw-standalone-build-v1\0")
    .update(
      JSON.stringify({
        ...provenance,
        ...(sourceGraphSha256 ? { sourceGraphSha256 } : {}),
        bun,
        openclaw,
        target: { platform: process.platform, arch: process.arch },
        mode,
        compileFlags,
        external: [...external].toSorted(),
        entry: path.relative(compileRoot, mainEntry).split(path.sep).join("/"),
        entries: [...compileEntries]
          .map((entry) => path.relative(compileRoot, entry).split(path.sep).join("/"))
          .toSorted(),
        resources,
        directories: [...resourcePlan.directories].toSorted(),
      }),
    )
    .digest("hex");
  /** @type {Artifact[]} */
  const flavors = [
    { mode, flavor: "standard", destination, outputRoot, compileFlags },
    ...(supportDestination
      ? [
          {
            mode: "jit",
            flavor: "support",
            destination: supportDestination,
            outputRoot: path.join(outputRoot, "support-artifact"),
            compileFlags: [],
          },
        ]
      : []),
  ];
  if (supportDestination) {
    stageSupportRuntime({
      runtimeRoot,
      outputRoot: path.join(outputRoot, "support-artifact"),
      bunExecutable,
      omittedDirs: plugins.omittedDirs,
    });
  }
  /** @type {CompiledArtifact[]} */
  const compiledArtifacts = [];
  for (const artifact of flavors) {
    fs.mkdirSync(artifact.outputRoot, { recursive: true });
    const build = {
      ...provenance,
      id,
      flavor: artifact.flavor,
      ...(artifact.flavor === "support" ? { debugEntry: "debug/entry.mjs" } : {}),
    };
    const buildInfo = {
      mode: artifact.mode,
      build,
      openclaw,
      bun,
      target: { platform: process.platform, arch: process.arch },
      plugins: { embedded: plugins.embedded.toSorted(), omitted: plugins.omitted.toSorted() },
      nativeModules,
    };
    const restoreStamp = stampStandaloneBuild(compiledEntries, buildInfo);
    try {
      if (artifact.mode === "aot" && compileAot) {
        await compileAot({ outfile: path.join(artifact.outputRoot, "openclaw"), buildInfo });
      } else if (artifact.mode === "aot") {
        // Trim feature retention is API-only; keep native compilation in a child process.
        const driver = path.join(artifact.outputRoot, "compile-aot.mjs");
        const options = {
          entrypoints: [
            mainEntry,
            ...compiledEntries.filter((entry) => entry !== mainEntry && compileEntries.has(entry)),
          ].map((entry) => path.relative(compileCwd, entry)),
          root: compileRoot,
          target: "bun",
          splitting: true,
          format: "esm",
          external,
          compile: {
            outfile: path.join(artifact.outputRoot, "openclaw"),
            aot: true,
            ...aotCompileOptions,
            autoloadPackageJson: true,
            autoloadDotenv: false,
            autoloadBunfig: false,
          },
        };
        fs.writeFileSync(
          driver,
          `const result = await Bun.build(${JSON.stringify(options)});\nfor (const log of result.logs) console.error(log);\nif (!result.success) process.exit(1);\n`,
        );
        try {
          const compiled = spawnSync(bunExecutable, [driver], {
            stdio: "inherit",
            cwd: compileCwd,
          });
          if (compiled.error) {
            throw compiled.error;
          }
          if (compiled.status !== 0) {
            throw new Error(
              `Standalone ${artifact.flavor} compilation failed (${compiled.status})`,
            );
          }
        } finally {
          fs.unlinkSync(driver);
        }
      } else {
        const compiled = spawnSync(
          bunExecutable,
          [
            "build",
            "--compile",
            "--splitting",
            "--format=esm",
            `--root=${compileRoot}`,
            "--compile-autoload-package-json",
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
            ...artifact.compileFlags,
            ...external.map((specifier) => `--external=${specifier}`),
            path.relative(compileCwd, mainEntry),
            ...compiledEntries
              .filter((entry) => entry !== mainEntry && compileEntries.has(entry))
              .map((entry) => path.relative(compileCwd, entry)),
            `--outfile=${path.join(artifact.outputRoot, "openclaw")}`,
          ],
          { stdio: "inherit", cwd: compileCwd },
        );
        if (compiled.error) {
          throw compiled.error;
        }
        if (compiled.status !== 0) {
          throw new Error(`Standalone ${artifact.flavor} compilation failed (${compiled.status})`);
        }
      }
      if (artifact.flavor === "support") {
        const bootstrap = `import { fileURLToPath } from "node:url";
globalThis.__openclawStandaloneBuildInfo = Object.freeze(${JSON.stringify(buildInfo)});
${sqlite.path ? `if (!process.env.OPENCLAW_SQLITE_LIBRARY?.trim()) { process.env.OPENCLAW_SQLITE_LIBRARY = fileURLToPath(new URL(${JSON.stringify("./runtime/" + sqlite.path)}, import.meta.url)); }` : ""}
`;
        fs.writeFileSync(path.join(artifact.outputRoot, "debug/bootstrap.mjs"), bootstrap);
        const entry = `import "./bootstrap.mjs";
import { fileURLToPath } from "node:url";
process.execArgv.push("--import", fileURLToPath(new URL("./bootstrap.mjs", import.meta.url)));
const entry = new URL("./runtime/openclaw.mjs", import.meta.url);
process.argv[1] = fileURLToPath(entry);
await import(entry.href);
`;
        fs.writeFileSync(path.join(artifact.outputRoot, "debug/entry.mjs"), entry);
      }
      compiledArtifacts.push({ ...artifact, build });
    } finally {
      restoreStamp();
    }
  }
  return compiledArtifacts;
}

/**
 * Publish relocatable artifacts after compilation and the shared resource plan succeed.
 * @param {{artifacts: CompiledArtifact[], runtimeRoot: string,
 * manifestInputs: Omit<Parameters<typeof createStandaloneManifest>[0], "outputRoot" | "mode" | "build" | "debug">}} options
 */
export async function publishStandaloneArtifacts({ artifacts, runtimeRoot, manifestInputs }) {
  // Copy all sidecars before moving the standard one out of the staging directory.
  for (const artifact of artifacts) {
    if (artifact.flavor === "support") {
      fs.cpSync(runtimeRoot, path.join(artifact.outputRoot, "runtime"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
  }
  for (const artifact of artifacts) {
    const debugEntry = path.join(artifact.outputRoot, "debug/entry.mjs");
    const debugBootstrap = path.join(artifact.outputRoot, "debug/bootstrap.mjs");
    const debugExecutable = path.join(artifact.outputRoot, "debug/bin/bun");
    const debug =
      artifact.flavor === "support"
        ? {
            entry: {
              path: "debug/entry.mjs",
              sizeBytes: fs.statSync(debugEntry).size,
              sha256: await sha256File(debugEntry),
            },
            bootstrap: {
              path: "debug/bootstrap.mjs",
              sizeBytes: fs.statSync(debugBootstrap).size,
              sha256: await sha256File(debugBootstrap),
            },
            executable: {
              path: "debug/bin/bun",
              sizeBytes: fs.statSync(debugExecutable).size,
              sha256: await sha256File(debugExecutable),
            },
            runtime: {
              ...(await describeStandaloneRuntime(path.join(artifact.outputRoot, "debug/runtime"))),
              path: "debug/runtime",
            },
          }
        : undefined;
    const manifest = await createStandaloneManifest({
      ...manifestInputs,
      debug,
      outputRoot: artifact.outputRoot,
      mode: artifact.mode,
      build: artifact.build,
    });
    fs.mkdirSync(path.dirname(artifact.destination), { recursive: true });
    fs.mkdirSync(artifact.destination);
    fs.renameSync(
      path.join(artifact.outputRoot, "openclaw"),
      path.join(artifact.destination, "openclaw"),
    );
    fs.renameSync(
      path.join(artifact.outputRoot, "runtime"),
      path.join(artifact.destination, "runtime"),
    );
    if (artifact.flavor === "support") {
      fs.renameSync(
        path.join(artifact.outputRoot, "debug"),
        path.join(artifact.destination, "debug"),
      );
    }
    fs.writeFileSync(
      path.join(artifact.destination, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    console.log(
      `Standalone ${artifact.flavor} ready: ${path.join(artifact.destination, "openclaw")}`,
    );
  }
}
