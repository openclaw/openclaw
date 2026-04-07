import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const tscBin = require.resolve("typescript/bin/tsc");

function runNodeStep(label, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      settled = true;
      rejectPromise(
        new Error(`${label}\n${stdout}${stderr}\n${label} timed out after ${timeoutMs}ms`.trim()),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      rejectPromise(new Error(`${label}\n${stdout}${stderr}\n${error.message}`.trim()));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${label}\n${stdout}${stderr}`.trim()));
    });
  });
}

async function main() {
  try {
    await Promise.all([
      runNodeStep(
        "plugin-sdk boundary dts",
        [tscBin, "-p", "tsconfig.plugin-sdk.dts.json"],
        300_000,
      ),
      runNodeStep(
        "plugin-sdk package boundary dts",
        [tscBin, "-p", "packages/plugin-sdk/tsconfig.json"],
        300_000,
      ),
    ]);
    await runNodeStep(
      "plugin-sdk boundary root shims",
      ["--import", "tsx", resolve(repoRoot, "scripts/write-plugin-sdk-entry-dts.ts")],
      120_000,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

await main();
