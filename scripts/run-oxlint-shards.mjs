import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runner = path.resolve("scripts", "run-oxlint.mjs");

const DEFAULT_SHARDS = [
  {
    name: "core",
    args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "ui", "packages"],
  },
  {
    name: "extensions",
    args: ["--tsconfig", "config/tsconfig/oxlint.extensions.json", "extensions"],
  },
  {
    name: "scripts",
    args: ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts"],
  },
];

const SPLIT_CORE_SHARDS = [
  {
    name: "core-src",
    args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src"],
  },
  {
    name: "core-ui",
    args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "ui"],
  },
  {
    name: "core-packages",
    args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "packages"],
  },
];

export function parseOxlintShardArgs(argv) {
  const only = new Set();
  const passThroughArgs = [];
  let splitCore = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--split-core") {
      splitCore = true;
      continue;
    }
    if (arg === "--only") {
      const value = argv[index + 1];
      if (value) {
        for (const item of value.split(",")) {
          const normalized = item.trim();
          if (normalized) {
            only.add(normalized);
          }
        }
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--only=")) {
      for (const item of arg.slice("--only=".length).split(",")) {
        const normalized = item.trim();
        if (normalized) {
          only.add(normalized);
        }
      }
      continue;
    }
    passThroughArgs.push(arg);
  }
  return {
    only: only.size > 0 ? [...only] : null,
    splitCore,
    passThroughArgs,
  };
}

export function resolveOxlintShards(options = {}) {
  const only = new Set(options.only ?? []);
  const shards = [];
  for (const shard of DEFAULT_SHARDS) {
    if (only.size > 0 && !only.has(shard.name)) {
      continue;
    }
    if (shard.name === "core" && options.splitCore) {
      shards.push(...SPLIT_CORE_SHARDS);
      continue;
    }
    shards.push(shard);
  }
  return shards;
}

export async function runOxlintShards(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseOxlintShardArgs(argv);
  const prepareResult = spawnSync(
    process.execPath,
    [path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mjs")],
    {
      stdio: "inherit",
      env,
    },
  );

  if (prepareResult.error) {
    throw prepareResult.error;
  }
  if ((prepareResult.status ?? 1) !== 0) {
    return prepareResult.status ?? 1;
  }

  const shards = resolveOxlintShards(parsed);
  const runSerial = env.OPENCLAW_OXLINT_SHARDS_SERIAL === "1";
  const results = runSerial
    ? await runShardsSerial(shards, parsed.passThroughArgs, env)
    : await Promise.all(shards.map((shard) => runShard(shard, parsed.passThroughArgs, env)));
  return results.find((status) => status !== 0) ?? 0;
}

async function runShardsSerial(entries, extraArgs, env) {
  const results = [];
  for (const shard of entries) {
    results.push(await runShard(shard, extraArgs, env));
  }
  return results;
}

async function runShard(shard, extraArgs, env) {
  console.error(`[oxlint:${shard.name}] starting`);
  const child = spawn(process.execPath, [runner, ...shard.args, ...extraArgs], {
    stdio: "inherit",
    env: {
      ...env,
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_OXLINT_SKIP_PREPARE: "1",
    },
  });

  return await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.once("close", (status) => {
      console.error(`[oxlint:${shard.name}] finished`);
      resolve(status ?? 1);
    });
  });
}

function isDirectRun() {
  const direct = process.argv[1];
  return Boolean(direct && fileURLToPath(import.meta.url) === path.resolve(direct));
}

if (isDirectRun()) {
  process.exitCode = await runOxlintShards();
}
