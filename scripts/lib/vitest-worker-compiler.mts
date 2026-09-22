// Native Node/Bun entry: the invocation parent never imports this compiler graph.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBuildInfo } from "../write-build-info.ts";
import { createManagedHandoffBuildConfig } from "./managed-handoff-build-config.mts";
import { collectRuntimeImportClosure } from "./runtime-import-closure.mts";
import {
  sharedRuntimeProcessBuildEntries,
  shouldBundleRuntimeSqliteDependency,
  standaloneRuntimeProcessBuildEntries,
} from "./runtime-process-core-build-entries.mts";
import { createStateSchemaInlinePlugin } from "./state-schema-inline-plugin.mts";
import {
  hashVitestWorkerArtifact,
  verifyVitestWorkerArtifacts,
  type VitestWorkerManifest,
} from "./vitest-worker-artifacts.mts";
import {
  preservedModuleBuildSources,
  vitestWorkerBuildEntries,
} from "./vitest-worker-build-entries.mts";
import { useVitestWorkerCache } from "./vitest-worker-cache-policy.mts";
import {
  vitestWorkerDeclarationEntries,
  vitestWorkerRuntimeAssets,
} from "./vitest-worker-declarations.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

async function compileVitestWorkerArtifacts(directory: string): Promise<void> {
  const started = performance.now();
  const reportPhase = (phase: string) => {
    if (process.env.OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN === "1") {
      console.error(`[vitest-workers] ${phase} after ${Math.round(performance.now() - started)}ms`);
    }
  };
  const compilerInputs = collectRuntimeImportClosure(
    root,
    [
      "scripts/lib/vitest-worker-compiler.mts",
      "scripts/lib/vitest-worker-run.mts",
      "scripts/lib/vitest-cli-mode.mts",
    ],
    { includeDynamicImports: true },
  );
  const cache = useVitestWorkerCache(process.env, process.execArgv)
    ? await (
        await import("./vitest-worker-cache.mts")
      ).createVitestWorkerCache(root, directory, compilerInputs)
    : undefined;
  const restored = await cache?.restore();
  if (cache) {
    console.error(
      `[vitest-workers] local cache ${restored ? "hit" : "miss"} after ${Math.round(performance.now() - started)}ms`,
    );
  }
  if (restored) {
    await writeVitestWorkerManifest(directory, restored.inputs, restored.outputs, started, {
      restored: true,
      cacheSignature: restored.cacheSignature,
    });
    console.error("[vitest-workers] reused local compiler outputs");
    return;
  }
  // The native child owns the compiler module graph for this one preparation.
  const { build }: typeof import("tsdown") = require("tsdown");
  const inputs: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  const packageDirectories = new Set<string>();
  const legacyOutputPrefix = "legacy-finalizer/";
  const recordInput = (id: string) => {
    const normalized = id.replaceAll("\\", "/");
    if (!path.isAbsolute(normalized)) {
      return;
    }
    const filename = path.normalize(normalized);
    const installed = normalized.split("/").includes("node_modules");
    if (installed && !cache) {
      return;
    }
    if (!installed && normalized.split("/").includes("dist")) {
      throw new Error(`Compiled subprocess build tried to read dist: ${id}`);
    }
    if (Object.hasOwn(inputs, filename)) {
      return;
    }
    if (fs.statSync(filename).isFile()) {
      inputs[filename] ??= hashVitestWorkerArtifact(fs.readFileSync(filename));
    }
  };
  for (const name of [
    "tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
    // Pin compiler, lifetime, and source-versus-compiled selection code, including lazy platforms.
    ...compilerInputs,
  ]) {
    recordInput(path.join(root, name));
  }
  const entry = {
    ...vitestWorkerBuildEntries,
    ...vitestWorkerDeclarationEntries,
  };
  const outDir = path.join(directory, "dist");
  const shouldBundleWorkspaceDependency = (id: string) =>
    (id.startsWith("@openclaw/") || id.startsWith("openclaw/")) &&
    id !== "@openclaw/fs-safe" &&
    !id.startsWith("@openclaw/fs-safe/");
  const createInputPlugins = (outputPrefix: string) => {
    const schemaPlugin = createStateSchemaInlinePlugin(root);
    return [
      {
        ...schemaPlugin,
        name: "openclaw:worker-build-inputs",
        load(id) {
          recordInput(id);
          // Keep schema loading in this callback instead of crossing into JS twice per input.
          return schemaPlugin.load.call(
            {
              addWatchFile: (file) => {
                recordInput(file);
                this.addWatchFile(file);
              },
            },
            id,
          );
        },
        generateBundle(_options, bundle) {
          for (const input of Object.keys(inputs)) {
            let packageDirectory = path.dirname(input);
            if (packageDirectories.has(packageDirectory)) {
              continue;
            }
            packageDirectories.add(packageDirectory);
            while (packageDirectory.startsWith(root)) {
              const manifest = path.join(packageDirectory, "package.json");
              if (fs.existsSync(manifest)) {
                recordInput(manifest);
                break;
              }
              packageDirectory = path.dirname(packageDirectory);
            }
          }
          for (const [name, output] of Object.entries(bundle)) {
            outputs[outputPrefix + name] = hashVitestWorkerArtifact(
              output.type === "chunk" ? output.code : Buffer.from(output.source),
            );
          }
        },
      },
    ] satisfies NonNullable<Parameters<typeof build>[0]>["plugins"];
  };
  const commonPlugins = createInputPlugins("");
  const config: NonNullable<Parameters<typeof build>[0]> = {
    config: false,
    cwd: root,
    entry: sharedRuntimeProcessBuildEntries(entry),
    outDir,
    format: "esm",
    platform: "node",
    tsconfig: path.join(root, "tsconfig.json"),
    dts: false,
    envPrefix: [],
    clean: false,
    outExtensions: () => ({ js: ".js" }),
    deps: {
      // Runtime entries share bundled query builders; other root dependencies stay external.
      alwaysBundle: (id) =>
        shouldBundleWorkspaceDependency(id) || shouldBundleRuntimeSqliteDependency(id),
    },
    logLevel: "warn",
    plugins: [
      {
        name: "openclaw:maintenance-service-boundary",
        resolveId: {
          // Keep normalization aliases: the target component can come from either operand.
          filter: [
            {
              kind: "include",
              expr: {
                kind: "or",
                args: [
                  { kind: "id", pattern: /service\.[jt]s/, params: { cleanUrl: false } },
                  { kind: "importerId", pattern: /service\.[jt]s/, params: { cleanUrl: false } },
                ],
              },
            },
          ],
          handler(id, importer) {
            if (
              importer &&
              id.startsWith(".") &&
              path.resolve(path.dirname(importer), id).replace(/\.js$/u, ".ts") ===
                path.join(root, "src/daemon/service.ts")
            ) {
              return {
                id: pathToFileURL(path.join(outDir, "triage-maintenance/service.js")).href,
                external: "absolute",
              };
            }
            return null;
          },
        },
      },
      {
        name: "openclaw:discord-voice-package-boundary",
        resolveId(id, importer) {
          if (!importer || !id.startsWith(".")) {
            return null;
          }
          const source = path.resolve(path.dirname(importer), id).replace(/\.js$/u, ".ts");
          if (source !== path.join(root, "extensions/discord/src/voice/sdk-runtime.ts")) {
            return null;
          }
          // This small native TypeScript module uses createRequire(import.meta.url)
          // to resolve Discord's own voice dependency; shared chunks lose that owner.
          recordInput(source);
          return { id: pathToFileURL(source).href, external: "absolute" };
        },
      },
      ...commonPlugins,
    ],
  };
  const compileShared = async () => {
    await build(config);
    reportPhase("shared entries compiled");
    for (const [name, source] of Object.entries(entry)) {
      if (!Object.hasOwn(standaloneRuntimeProcessBuildEntries, name)) {
        continue;
      }
      await build({
        ...config,
        entry: { [name]: source },
        outputOptions: { codeSplitting: false },
      });
    }
    reportPhase("standalone workers compiled");
    await build({
      ...createManagedHandoffBuildConfig(),
      config: false,
      cwd: root,
      outDir,
      clean: false,
      logLevel: config.logLevel,
      plugins: config.plugins,
    });
    reportPhase("managed handoff compiled");
  };
  const compilePreservedModules = async () => {
    const fixtureBoundaries = new Set(
      preservedModuleBuildSources.map((source) => path.join(root, source)),
    );
    await build({
      ...config,
      // Array entries honor root; object entries infer src/ and break import.meta paths.
      entry: preservedModuleBuildSources,
      outDir: path.join(outDir, "legacy-finalizer"),
      root,
      // Load hooks forward the complete original namespaces through query imports.
      unbundle: true,
      treeshake: false,
      inputOptions: { preserveEntrySignatures: "strict" },
      outputOptions: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
      // Hooked owners must stay in this single preserved graph.
      plugins: [
        {
          name: "openclaw:fixture-module-boundaries",
          resolveId(id, importer) {
            if (!importer || !id.startsWith(".")) {
              return null;
            }
            const source = path.resolve(path.dirname(importer), id).replace(/\.js$/u, ".ts");
            if (!fixtureBoundaries.has(source)) {
              return null;
            }
            // Keep hookable barrels intact instead of redirecting imports to their leaf owners.
            return {
              id: pathToFileURL(
                path.join(
                  outDir,
                  legacyOutputPrefix,
                  path.relative(root, source).replace(/\.ts$/u, ".js"),
                ),
              ).href,
              external: "absolute",
            };
          },
        },
        ...createInputPlugins(legacyOutputPrefix),
      ],
    });
    reportPhase("preserved fixture modules compiled");
  };
  // Serial preparation measured about 3 GiB RSS; leave headroom for both graphs.
  if (cache && process.availableMemory() >= 8 * 1024 ** 3) {
    // These outputs occupy separate subtrees. Join both writers even if one fails.
    const completed = await Promise.allSettled([compileShared(), compilePreservedModules()]);
    const failed = completed.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
  } else {
    await compileShared();
    await compilePreservedModules();
  }
  for (const source of preservedModuleBuildSources) {
    fs.accessSync(path.join(outDir, legacyOutputPrefix, source.replace(/\.ts$/u, ".js")));
  }
  for (const name of Object.keys(entry)) {
    fs.accessSync(path.join(directory, "dist", `${name}.js`));
  }
  for (const asset of vitestWorkerRuntimeAssets) {
    const source = path.join(root, asset);
    const destination = path.join(directory, asset);
    const contents = fs.readFileSync(source);
    const hash = hashVitestWorkerArtifact(contents);
    inputs[source] ??= hash;
    fs.writeFileSync(destination, contents, { flag: "wx" });
    // Output paths stay relative to dist, including package-root runtime assets.
    outputs[path.relative(outDir, destination).replaceAll("\\", "/")] = hash;
  }
  const manifest = await writeVitestWorkerManifest(directory, inputs, outputs, started, {
    inputsChangedAfter: cache?.startedAt,
  });
  reportPhase("compiler outputs verified");
  if (cache) {
    manifest.cacheSignature = await cache.seal(manifest);
    reportPhase("compiler cache inputs sealed");
  }
  manifest.durationMs = performance.now() - started;
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
}

async function writeVitestWorkerManifest(
  directory: string,
  inputs: Record<string, string>,
  outputs: Record<string, string>,
  started: number,
  {
    restored = false,
    inputsChangedAfter,
    cacheSignature,
  }: { restored?: boolean; inputsChangedAfter?: number; cacheSignature?: string } = {},
): Promise<VitestWorkerManifest> {
  const outDir = path.join(directory, "dist");
  // Version consumers need the built source identity without making this
  // disposable generation a competing OpenClaw installation root.
  const buildInfo = `${JSON.stringify(resolveBuildInfo({ rootDir: root }), null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, "build-info.json"), buildInfo, restored ? {} : { flag: "wx" });
  outputs["build-info.json"] = hashVitestWorkerArtifact(buildInfo);
  const sortedInputs = Object.fromEntries(
    Object.entries(inputs).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const sortedOutputs = Object.fromEntries(
    Object.entries(outputs).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const manifest: VitestWorkerManifest = {
    identity: hashVitestWorkerArtifact(JSON.stringify([sortedInputs, sortedOutputs])),
    inputs: sortedInputs,
    outputs: sortedOutputs,
    durationMs: performance.now() - started,
    ...(cacheSignature ? { cacheSignature } : {}),
  };
  // Restoration verified these bytes before transferring exclusive ownership.
  // The borrower boundary still verifies the refreshed manifest before lending.
  if (!restored) {
    await verifyVitestWorkerArtifacts(directory, manifest, { inputsChangedAfter });
  }
  manifest.durationMs = performance.now() - started;
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(manifest)}\n`,
    restored ? {} : { flag: "wx" },
  );
  return manifest;
}

if (import.meta.main) {
  try {
    const directory = fs.realpathSync(process.argv[2]!);
    const parent = fs.realpathSync(path.join(root, ".artifacts/vitest-workers"));
    if (
      process.argv.length !== 3 ||
      path.dirname(directory) !== parent ||
      !path.basename(directory).startsWith("run-") ||
      fs.readdirSync(directory).some((name) => name !== "package.json")
    ) {
      throw new Error("Compiled subprocess compiler requires a fresh invocation directory");
    }
    await compileVitestWorkerArtifacts(directory);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
