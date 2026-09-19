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
import path from "node:path";
import { distArtifactEntryArgs } from "./dist-artifact-ownership.mts";
import { runManagedCommand } from "./managed-child-process.mts";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "./tsdown-config-groups.mts";

/**
 * Build the unified runtime entries and publish the base declaration partition
 * that owns the typed runtime entries, without touching unrelated partitions.
 */
export async function buildTsgoCoreTestTypedRuntimeDist(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): Promise<number> {
  console.error(
    "[tsgo core test] building typed runtime dist entries before dist-dependent shards",
  );
  const runtime = await runManagedCommand({
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
    env: { ...env, OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
    requireProcessTreeExit: process.platform !== "win32",
  });
  if (runtime !== 0) {
    return runtime;
  }
  return runManagedCommand({
    bin: process.execPath,
    args: distArtifactEntryArgs(path.join(repoRoot, "scripts/write-typed-runtime-entry-dts.ts")),
    cwd: repoRoot,
    env,
    requireProcessTreeExit: process.platform !== "win32",
  });
}
