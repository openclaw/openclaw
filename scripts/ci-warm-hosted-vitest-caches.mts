import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVitestCacheWarmGroups } from "./lib/ci-node-test-plan.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

// These entrypoints choose different writable cache leaves. Collect through the
// consumers themselves so scheduler-owned leaves remain isolated and reusable.
const groups = createVitestCacheWarmGroups("hybrid-hosted");
const scratch = mkdtempSync(join(tmpdir(), "openclaw-hosted-cache-warm-"));
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--testNamePattern=(?!)"]',
};
delete baseEnv.OPENCLAW_VITEST_INCLUDE_FILE;
let exitCode = 0;
let interrupted = false;
let completed = false;
const collect = async (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
  if (interrupted) {
    return;
  }
  const code = await runManagedCommand({
    bin,
    args,
    env,
    requireProcessTreeExit: true,
    onSignal() {
      interrupted = true;
    },
  });
  exitCode ||= code;
};

try {
  const tooling = groups.find((group) => group.shard_name === "cache-warm:hosted-tooling");
  if (!tooling?.includePatterns) {
    throw new Error("Missing hosted CI-routing cache seed");
  }
  await collect("pnpm", ["test", ...tooling.includePatterns, "--testNamePattern=(?!)"], {
    ...baseEnv,
    OPENCLAW_TEST_PROJECTS_PARALLEL: "3",
  });
  for (const [script, prefix, concurrency] of [
    ["test:contracts:plugins", "cache-warm:hosted-contracts-plugin", "1"],
    ["test:contracts:channels", "cache-warm:hosted-contracts-channel-", "4"],
  ] as const) {
    const includeFile = join(scratch, `${concurrency}.json`);
    writeFileSync(
      includeFile,
      JSON.stringify(
        groups
          .filter((group) => group.shard_name.startsWith(prefix))
          .flatMap((group) => group.includePatterns ?? []),
      ),
    );
    await collect("pnpm", [script, "--testNamePattern=(?!)"], {
      ...baseEnv,
      OPENCLAW_TEST_PROJECTS_PARALLEL: concurrency,
      OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
    });
  }
  // UI uses the same shard runner in CI. Its final pruning also bounds the
  // direct and scheduler-owned leaves collected above before publication.
  await collect(process.execPath, ["--import", "tsx", "scripts/ci-run-node-test-shard.mts"], {
    ...baseEnv,
    OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
      groups.filter((group) => group.shard_name === "cache-warm:ui-package"),
    ),
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
  });
  process.exitCode = exitCode;
  completed = true;
} finally {
  if (completed) {
    rmSync(scratch, { recursive: true, force: true });
  }
}
