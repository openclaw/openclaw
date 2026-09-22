// Native Node/Bun entry: the invocation parent never imports this compiler graph.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBuildInfo } from "../write-build-info.ts";
import { createManagedHandoffBuildConfig } from "./managed-handoff-build-config.mts";
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
  legacyFinalizerBuildSources,
  vitestWorkerBuildEntries,
} from "./vitest-worker-build-entries.mts";
import { vitestWorkerDeclarationEntries } from "./vitest-worker-declarations.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

async function compileVitestWorkerArtifacts(directory: string): Promise<void> {
  const started = performance.now();
  // The native child owns the compiler module graph for this one preparation.
  const { build }: typeof import("tsdown") = require("tsdown");
  const inputs: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  let outputPrefix = "";
  const recordInput = (id: string) => {
    const normalized = id.replaceAll("\\", "/");
    if (!path.isAbsolute(normalized) || normalized.split("/").includes("node_modules")) {
      return;
    }
    if (normalized.split("/").includes("dist")) {
      throw new Error(`Compiled subprocess build tried to read dist: ${id}`);
    }
    const filename = path.normalize(normalized);
    if (fs.statSync(filename).isFile()) {
      inputs[filename] ??= hashVitestWorkerArtifact(fs.readFileSync(filename));
    }
  };
  for (const name of [
    "tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/lib/vitest-worker-artifacts.mts",
    "scripts/lib/vitest-worker-declarations.mts",
    "scripts/lib/managed-handoff-build-config.mts",
    "scripts/lib/vitest-worker-run.mts",
    "scripts/lib/vitest-worker-compiler.mts",
    "scripts/lib/managed-child-process.mts",
    "scripts/lib/vitest-resource-ownership.mts",
    "scripts/lib/windows-taskkill.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/runtime-process-build-entries.mts",
    "scripts/lib/runtime-process-core-build-entries.mts",
    "scripts/lib/vitest-worker-build-entries.mts",
    "scripts/lib/state-schema-inline-plugin.mts",
    "scripts/write-build-info.ts",
    "scripts/lib/direct-run.mjs",
    "ui/src/build-info-normalizers.ts",
    "packages/normalization-core/src/record-coerce.ts",
    "packages/normalization-core/src/string-coerce.ts",
    "packages/normalization-core/src/utf16-slice.ts",
    "scripts/lib/vitest-cli-mode.mts",
  ]) {
    recordInput(path.join(root, name));
  }
  const entry = {
    ...vitestWorkerBuildEntries,
    ...vitestWorkerDeclarationEntries,
  };
  const schemaPlugin = createStateSchemaInlinePlugin(root);
  const outDir = path.join(directory, "dist");
  const shouldBundleWorkspaceDependency = (id: string) =>
    (id.startsWith("@openclaw/") || id.startsWith("openclaw/")) &&
    id !== "@openclaw/fs-safe" &&
    !id.startsWith("@openclaw/fs-safe/");
  const commonPlugins = [
    {
      name: "openclaw:worker-build-inputs",
      load(id) {
        recordInput(id);
        return null;
      },
      generateBundle(_options, bundle) {
        const packageDirectories = new Set(Object.keys(inputs).map((id) => path.dirname(id)));
        for (let packageDirectory of packageDirectories) {
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
    {
      ...schemaPlugin,
      load(id) {
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
    },
  ] satisfies NonNullable<Parameters<typeof build>[0]>["plugins"];
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
        resolveId(id, importer) {
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
      ...commonPlugins,
    ],
  };
  await build(config);
  for (const [name, source] of Object.entries(standaloneRuntimeProcessBuildEntries)) {
    await build({
      ...config,
      entry: { [name]: source },
      outputOptions: { codeSplitting: false },
    });
  }
  await build({
    ...createManagedHandoffBuildConfig(),
    config: false,
    cwd: root,
    outDir,
    clean: false,
    logLevel: config.logLevel,
    plugins: config.plugins,
  });
  outputPrefix = "legacy-finalizer/";
  await build({
    ...config,
    // Array entries honor root; object entries infer src/ and break import.meta paths.
    entry: legacyFinalizerBuildSources,
    outDir: path.join(outDir, "legacy-finalizer"),
    root,
    // Load hooks forward the complete original namespaces through query imports.
    unbundle: true,
    treeshake: false,
    inputOptions: { preserveEntrySignatures: "strict" },
    outputOptions: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    // Hooked service and authority owners must stay in this single preserved graph.
    plugins: commonPlugins,
  });
  for (const source of legacyFinalizerBuildSources) {
    fs.accessSync(path.join(outDir, outputPrefix, source.replace(/\.ts$/u, ".js")));
  }
  for (const name of Object.keys(entry)) {
    fs.accessSync(path.join(directory, "dist", `${name}.js`));
  }
  // Version consumers need the built source identity without making this
  // disposable generation a competing OpenClaw installation root.
  const buildInfo = `${JSON.stringify(resolveBuildInfo({ rootDir: root }), null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, "build-info.json"), buildInfo, { flag: "wx" });
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
  };
  await verifyVitestWorkerArtifacts(directory, manifest);
  manifest.durationMs = performance.now() - started;
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, {
    flag: "wx",
  });
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
