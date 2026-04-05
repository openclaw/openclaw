import { spawnPnpmRunner } from "./pnpm-runner.mjs";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

function isTruthyEnvValue(value) {
  return TRUTHY_ENV_VALUES.has(value?.trim().toLowerCase() ?? "");
}

export function resolveVitestNodeArgs(env = process.env) {
  if (isTruthyEnvValue(env.OPENCLAW_VITEST_ENABLE_MAGLEV)) {
    return [];
  }

  return ["--no-maglev"];
}

function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 0) {
    console.error("usage: node scripts/run-vitest.mjs <vitest args...>");
    process.exit(1);
  }

  const child = spawnPnpmRunner({
    pnpmArgs: ["exec", "vitest", ...argv],
    nodeArgs: resolveVitestNodeArgs(env),
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

if (import.meta.main) {
  main();
}
