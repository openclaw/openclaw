// Builds the typed runtime dist entries a core-test type-check shard needs.
//
// A first-party e2e (embedded-agent-runner.retry-after-failover) imports built
// runtime entries from dist/. The tsgo core-test shard that owns that test
// resolves those `../../dist/*.js` specifiers, so both the entries and their
// .d.ts must exist before the checker runs.
//
// The runtime entries are built with the declaration skip flag set, which keeps
// the output cleaner from removing declared outputs it does not regenerate. The
// declarations the shard needs are then published through the canonical staged
// writer, which replaces only the base partition. Cleaning the shared output
// roots instead, with declarations unprotected, is what removed the SDK and
// extension declarations of an existing full build and broke later consumers
// such as scripts/check-plugin-sdk-exports.mts.
//
// That clean also removes runtime artifacts the unified graph does not rebuild:
// isolated plugin dists, copied plugin assets and the runtime postbuild outputs.
// A full build restores them in the steps that follow its compile, so this
// preparation runs those owners afterwards rather than duplicating their output
// lists or allowlisting paths inside them.
import path from "node:path";
// Type-only, so the step table's module stays out of this module's load graph.
import type { BuildAllStep } from "../build-all.mts";
import { distArtifactEntryArgs } from "./dist-artifact-ownership.mts";
import { runManagedCommand } from "./managed-child-process.mts";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "./tsdown-config-groups.mts";

/**
 * Owners of the runtime artifacts the unified build's clean removes and the
 * unified graph does not regenerate, named by their canonical build-all labels
 * so the preparation restores them through the same steps the full build runs.
 */
const RESTORED_RUNTIME_STEP_LABELS = [
  // The copy phase runs each plugin's assetScripts.copy, and the canvas copy
  // fails closed with "Missing A2UI bundle assets" until the build phase has
  // written the bundles it reads, so the producer is restored alongside it.
  // build-all runs the same pair in this order: build before the compile, copy
  // after the runtime setup steps and before postbuild records the asset
  // inventory.
  "plugins:assets:build",
  // runtime-postbuild verifies the built plugin control-plane modules, which
  // import @openclaw/ai/dist, and the clean removes the package output too.
  "tsdown-ai",
  "external-plugins:local-dist",
  "plugins:assets:copy",
  "runtime-postbuild",
] as const;

/**
 * The canonical step table lives in the build runner, which loads the build
 * toolchain and the source tree it drives. A shard launcher has to stay loadable
 * without any of that, because it is the launcher that decides whether a
 * preparation is needed at all, so the table is resolved on demand instead of at
 * module load.
 */
async function loadBuildAllSteps(): Promise<typeof import("../build-all.mts")> {
  return import("../build-all.mts");
}

/** Canonical build-all steps this preparation runs after its compile. */
export async function listRestoredRuntimeSteps(): Promise<BuildAllStep[]> {
  const { BUILD_ALL_STEPS } = await loadBuildAllSteps();
  return RESTORED_RUNTIME_STEP_LABELS.map((label) => {
    const step = BUILD_ALL_STEPS.find((candidate) => candidate.label === label);
    if (!step) {
      throw new Error(`build-all no longer defines the ${label} step`);
    }
    return step;
  });
}

/** Resolve one owner step to the node invocation that inherits checkout ownership. */
async function resolveRestoredRuntimeInvocation(
  step: BuildAllStep,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
) {
  const { resolveBuildAllStep } = await loadBuildAllSteps();
  // pnpm steps take their node fallback so the owner inherits the shard
  // runner's checkout ownership instead of starting a package-manager child.
  const resolved = resolveBuildAllStep(step, {
    env: { ...env, OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
  });
  const scriptIndex = resolved.args.findIndex((arg) => /\.(?:c|m)?(?:j|t)s$/u.test(arg));
  const script = scriptIndex < 0 ? undefined : resolved.args[scriptIndex];
  if (script === undefined) {
    throw new Error(`build-all step ${step.label} does not resolve to a script`);
  }
  return {
    args: distArtifactEntryArgs(
      path.resolve(repoRoot, script),
      resolved.args.slice(scriptIndex + 1),
    ),
    env: { ...env, ...resolved.options.env },
  };
}

/**
 * Build the unified runtime entries, restore the runtime artifacts that build's
 * clean removes through their canonical owners, and publish the base
 * declaration partition that owns the typed runtime entries.
 */
export async function buildTsgoCoreTestTypedRuntimeDist(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  runCommand: typeof runManagedCommand = runManagedCommand,
): Promise<number> {
  console.error(
    "[tsgo core test] building typed runtime dist entries before dist-dependent shards",
  );
  const runtime = await runCommand({
    bin: process.execPath,
    // Launched through the dist-artifact entry so it inherits the shard runner's
    // checkout ownership instead of blocking forever on the same lock.
    args: distArtifactEntryArgs(path.join(repoRoot, "scripts/tsdown-build.mts"), [
      "--config",
      "tsdown.config.ts",
      "--filter",
      TSDOWN_UNIFIED_CONFIG_GROUP,
    ]),
    cwd: repoRoot,
    // The declarations the shard needs come from the staged writer below, so a
    // clean here must not remove declared outputs it cannot regenerate.
    env: {
      ...env,
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      // None of the restored steps runs the metadata writer, so the existing
      // preservation contract in scripts/tsdown-build.mts keeps
      // dist/cli-startup-metadata.json; losing it disables precomputed help and
      // the channel names in CLI option descriptions.
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
    // Every preparation child launches Node directly: a Windows shell routes
    // the arguments through cmd.exe, which rejects the percent-encoded file URLs
    // the artifact entry produces when the checkout path contains spaces.
    shell: false,
    requireProcessTreeExit: process.platform !== "win32",
  });
  if (runtime !== 0) {
    return runtime;
  }
  for (const step of await listRestoredRuntimeSteps()) {
    const owner = await resolveRestoredRuntimeInvocation(step, env, repoRoot);
    const status = await runCommand({
      bin: process.execPath,
      args: owner.args,
      cwd: repoRoot,
      env: owner.env,
      shell: false,
      requireProcessTreeExit: process.platform !== "win32",
    });
    if (status !== 0) {
      return status;
    }
  }
  return runCommand({
    bin: process.execPath,
    args: distArtifactEntryArgs(path.join(repoRoot, "scripts/write-typed-runtime-entry-dts.ts")),
    cwd: repoRoot,
    env,
    shell: false,
    requireProcessTreeExit: process.platform !== "win32",
  });
}
