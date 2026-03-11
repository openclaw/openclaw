// Where: scripts/test-growth-ui.mjs
// What: runs the scoped growth UI Vitest lane with a safe temp directory environment.
// Why: WSL shells can inherit unusable Windows temp paths that break jsdom before any test runs.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

export function resolveGrowthUiTempRoot(env = process.env, platform = process.platform) {
  let candidate = env.TMPDIR || env.TMP || env.TEMP || "/tmp";
  if (
    platform !== "win32" &&
    (candidate.startsWith("/mnt/") || WINDOWS_DRIVE_PATH.test(candidate))
  ) {
    candidate = "/tmp";
  }
  return candidate;
}

export function buildGrowthUiEnv(env = process.env, platform = process.platform) {
  const tempRoot = resolveGrowthUiTempRoot(env, platform);
  return {
    ...env,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
  };
}

export function main(env = process.env, platform = process.platform) {
  if (env.OPENCLAW_TEST_GROWTH_UI_ECHO === "1") {
    const normalized = buildGrowthUiEnv(env, platform);
    process.stdout.write(
      JSON.stringify(
        {
          TMPDIR: normalized.TMPDIR,
          TMP: normalized.TMP,
          TEMP: normalized.TEMP,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  const command = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    command,
    ["exec", "vitest", "run", "--config", "vitest.growth-ui.config.ts"],
    {
      stdio: "inherit",
      env: buildGrowthUiEnv(env, platform),
    },
  );

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

const isDirectRun =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exit(main());
}
