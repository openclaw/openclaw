import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalTsgoPolicy,
} from "./lib/local-heavy-check-runtime.mjs";

const { args: finalArgs, env } = applyLocalTsgoPolicy(process.argv.slice(2), process.env);

const tsgoPath = path.resolve("node_modules", ".bin", "tsgo");
const releaseLock = acquireLocalHeavyCheckLockSync({
  cwd: process.cwd(),
  env,
  toolName: "tsgo",
});

try {
  const result = spawnSync(tsgoPath, finalArgs, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
} finally {
  releaseLock();
}
