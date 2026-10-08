// Branch-only A/B experiment; not a production workflow or package command.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runManagedCommand } from "./lib/managed-child-process.mts";

const [operation, mode, cache, output] = process.argv.slice(2);
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
if (scripts["check:docs"] !== "pnpm format:docs:check && pnpm check:docs:content") {
  throw new Error("The pinned docs command inventory changed");
}
if (operation === "command") {
  if (!["serial", "parallel"].includes(mode)) throw new Error("Invalid mode");
  process.exitCode = await runManagedCommand({
    bin: "pnpm",
    args:
      mode === "serial"
        ? ["check:docs"]
        : [
            "run",
            "--workspace-concurrency=2",
            "--no-bail",
            "/^(format:docs:check|check:docs:content)$/",
          ],
  });
} else if (operation === "measure") {
  mkdirSync(cache, { recursive: true });
  mkdirSync(output, { recursive: true });
  const available = () =>
    Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync("/proc/meminfo", "utf8"))[1]);
  const initialAvailableKiB = available();
  let minAvailableKiB = initialAvailableKiB;
  const sampler = setInterval(() => {
    minAvailableKiB = Math.min(minAvailableKiB, available());
  }, 200);
  const start = performance.now();
  let status;
  try {
    status = await runManagedCommand({
      bin: "/usr/bin/time",
      args: [
        "-v",
        "-o",
        join(output, "time.txt"),
        process.execPath,
        "scripts/ci-docs-benchmark.mjs",
        "command",
        mode,
      ],
      env: {
        ...process.env,
        XDG_CACHE_HOME: cache,
        PNPM_CONFIG_CACHE_DIR: cache,
        PNPM_CONFIG_STORE_DIR: join(cache, "store"),
      },
    });
  } finally {
    clearInterval(sampler);
  }
  const result = {
    mode,
    status,
    elapsedMs: performance.now() - start,
    initialAvailableKiB,
    minAvailableKiB,
    availableMemoryDeltaKiB: initialAvailableKiB - minAvailableKiB,
  };
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  process.exitCode = status;
} else {
  throw new Error("Invalid operation");
}
