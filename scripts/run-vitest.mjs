import { createRequire } from "node:module";
import path from "node:path";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";
import {
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mjs";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const require = createRequire(import.meta.url);

function isTruthyEnvValue(value) {
  return TRUTHY_ENV_VALUES.has(value?.trim().toLowerCase() ?? "");
}

export function resolveVitestNodeArgs(env = process.env) {
  if (isTruthyEnvValue(env.OPENCLAW_VITEST_ENABLE_MAGLEV)) {
    return [];
  }

  return ["--no-maglev"];
}

export function resolveVitestCliEntry() {
  const vitestPackageJson = require.resolve("vitest/package.json");
  return path.join(path.dirname(vitestPackageJson), "vitest.mjs");
}

export function resolveVitestSpawnParams(env = process.env, platform = process.platform) {
  return {
    env,
    detached: shouldUseDetachedVitestProcessGroup(platform),
  };
}

function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 0) {
    console.error("usage: node scripts/run-vitest.mjs <vitest args...>");
    process.exit(1);
  }

  const spawnParams = resolveVitestSpawnParams(env);
  const child = spawnPnpmRunner({
    pnpmArgs: ["exec", "node", ...resolveVitestNodeArgs(env), resolveVitestCliEntry(), ...argv],
    ...spawnParams,
  });
  const teardownChildCleanup = installVitestProcessGroupCleanup({ child });

  child.on("exit", (code, signal) => {
    teardownChildCleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    teardownChildCleanup();
    console.error(error);
    process.exit(1);
  });
}

if (import.meta.main) {
  main();
}
