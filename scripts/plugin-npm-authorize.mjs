#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execPlainGh } from "./lib/plain-gh.mjs";

// Restart only read-only authorization, never npm publish or artifact consumption.
// A new process discards all previously authenticated mutable authority.
export async function authorizeWithQuotaReset(
  args,
  {
    authorize = () =>
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("./plugin-npm-prepared-release.mjs", import.meta.url)),
          "authorize",
          ...args,
        ],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      ),
    quota = () =>
      JSON.parse(execPlainGh(["api", "rate_limit"], { encoding: "utf8", timeout: 15_000 }))
        .resources.core,
    now = Date.now,
    wait = (ms) => setTimeout(ms),
    report = console.warn,
  } = {},
) {
  try {
    return authorize();
  } catch (error) {
    const diagnostic = String(error?.stderr ?? error?.message ?? "");
    if (
      !/API rate limit exceeded for installation\b/u.test(diagnostic) ||
      !/HTTP 403/u.test(diagnostic)
    ) {
      throw error;
    }
    const { limit, remaining, reset } = quota();
    const delay = Math.max(0, reset * 1000 - now()) + 5000;
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      !Number.isSafeInteger(remaining) ||
      remaining < 0 ||
      remaining > limit ||
      !Number.isSafeInteger(reset) ||
      reset <= 0 ||
      !Number.isSafeInteger(delay) ||
      delay > 3_700_000
    ) {
      throw new Error("GitHub quota reset is missing or outside the one-hour recovery bound", {
        cause: error,
      });
    }
    report(
      `GitHub installation quota: limit=${limit}, remaining=${remaining}, reset=${reset}; restarting authorization once after ${delay}ms.`,
    );
    await wait(delay);
    return authorize();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const output = await authorizeWithQuotaReset(process.argv.slice(2));
    if (output) {
      process.stdout.write(output);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
