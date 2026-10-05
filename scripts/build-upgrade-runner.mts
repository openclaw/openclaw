import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "tsdown";
import { runtimeProcessEntrypoints } from "../src/infra/runtime-process-entrypoints.js";
import { upgradeRecipeRunnerProcessNames } from "../src/infra/upgrade-recipes/runner-process-contract.js";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  createManagedHandoffBuildConfigs,
  createSealedRecoveryBuildConfig,
} from "./lib/managed-handoff-build-config.mts";

/** Build only; production bundles still require authenticated runtime/native artifact provisioning. */
export async function buildUpgradeRecipeRunner(
  outputDirectory: string,
  options?: {
    observerSourceMaps?: boolean;
  },
): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = path.resolve(outputDirectory);
  if (
    output === path.join(root, "dist") ||
    output.startsWith(`${path.join(root, "dist")}${path.sep}`)
  ) {
    throw new Error(
      "Standalone runner build requires private output outside shared dist artifacts.",
    );
  }
  const config = createSealedRecoveryBuildConfig({
    currentModuleUrl: new URL("../src/cli/update-cli/standalone-updater-entry.ts", import.meta.url)
      .href,
    sourceWorkerName: "standalone-updater-entry",
    distWorkerPath: "openclaw-updater.mjs",
  });
  // Both entries are sealed into the eventual production closure, not a second runner.
  const releaseConfig = createSealedRecoveryBuildConfig({
    currentModuleUrl: new URL(
      "../src/cli/update-cli/release-qualification-entry.ts",
      import.meta.url,
    ).href,
    sourceWorkerName: "release-qualification-entry",
    distWorkerPath: "openclaw-release-qualification.mjs",
  });
  const workers = upgradeRecipeRunnerProcessNames;
  const workerConfigs = workers.map((name) => {
    const entry = runtimeProcessEntrypoints[name];
    const source = fileURLToPath(new URL(`./${entry.sourceWorkerName}.ts`, entry.currentModuleUrl));
    const virtual = `sealed-upgrade-worker:${name}`;
    const workerConfig = createSealedRecoveryBuildConfig({
      ...entry,
      distWorkerPath: entry.distWorkerPath.replace(/\.js$/u, ".mjs"),
    });
    return Object.assign({}, workerConfig, {
      entry: { [entry.distWorkerPath.replace(/\.js$/u, "")]: virtual },
      plugins: [
        workerConfig.plugins,
        {
          name: "openclaw:sealed-upgrade-worker",
          resolveId(id: string) {
            return id === virtual ? `\0${virtual}` : null;
          },
          load(id: string) {
            return id === `\0${virtual}`
              ? `import ${JSON.stringify(fileURLToPath(new URL("../src/infra/sealed-runtime-bootstrap.ts", import.meta.url)))};
                 import { registerUpgradeRecipeRunnerProcesses } from ${JSON.stringify(fileURLToPath(new URL("../src/infra/upgrade-recipes/runner-processes.ts", import.meta.url)))};
                 registerUpgradeRecipeRunnerProcesses(new URL(${JSON.stringify(`${path.posix.relative(path.posix.dirname(entry.distWorkerPath), ".")}/`)}, import.meta.url));
                 await import(${JSON.stringify(source)});`
              : null;
          },
        },
      ],
    });
  });
  for (const sealed of [
    config,
    releaseConfig,
    ...createManagedHandoffBuildConfigs(),
    ...workerConfigs,
  ]) {
    // Disable project config discovery: this bounded owner must not accidentally
    // run the application's entire tsdown matrix or write its shared artifacts.
    await build({
      ...sealed,
      // Hidden companion maps support external exact-byte observation, never runtime hooks.
      ...(options?.observerSourceMaps ? { sourcemap: "hidden" as const } : {}),
      config: false,
      cwd: root,
      outDir: output,
      clean: false,
    });
  }
}
if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const output = process.argv[2];
  if (!output) {
    throw new Error("Supply a private output directory for the standalone runner build.");
  }
  const { values } = parseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      "observer-source-maps": { type: "boolean" },
    },
  });
  await buildUpgradeRecipeRunner(output, {
    observerSourceMaps: values["observer-source-maps"],
  });
}
