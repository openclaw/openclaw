import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const tscBin = require.resolve("typescript/bin/tsc");

function runNodeStep(label, args, timeoutMs) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (result.status === 0 && !result.error) {
    return;
  }

  const timeoutSuffix =
    result.error?.name === "Error" && result.error.message.includes("ETIMEDOUT")
      ? `\n${label} timed out after ${timeoutMs}ms`
      : "";
  const errorSuffix = result.error ? `\n${result.error.message}` : "";
  process.stderr.write(`${label}\n${result.stdout}${result.stderr}${timeoutSuffix}${errorSuffix}`);
  process.exit(result.status ?? 1);
}

runNodeStep("plugin-sdk boundary dts", [tscBin, "-p", "tsconfig.plugin-sdk.dts.json"], 300_000);
runNodeStep(
  "plugin-sdk package boundary dts",
  [tscBin, "-p", "packages/plugin-sdk/tsconfig.json"],
  300_000,
);
runNodeStep(
  "plugin-sdk boundary root shims",
  ["--import", "tsx", resolve(repoRoot, "scripts/write-plugin-sdk-entry-dts.ts")],
  120_000,
);
