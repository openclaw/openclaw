import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import { printTimingSummary } from "./lib/check-timing-summary.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { parseRatchetArgs } from "./lib/shrink-ratchet.mts";

export async function main(argv = process.argv.slice(2)) {
  if (parseRatchetArgs(argv).prune) {
    throw new Error("CI baseline ratchets cannot prune baselines.");
  }
  const checks = [
    // Only one large semantic inventory runs; the second slot drains smaller checks.
    { name: "database-worker", args: ["check:database-worker-ratchet", ...argv] },
    { name: "max-lines", args: ["check:max-lines-ratchet", ...argv] },
    ...(process.env.RATCHET_PR_HEAD_SHA
      ? [{ name: "line-cap", args: ["check:line-cap-ratchet", ...argv] }]
      : []),
    { name: "assertion-safety", args: ["check:assertion-safety", ...argv] },
    { name: "database-dialect", args: ["check:database-dialect-ratchet", ...argv] },
    { name: "timeout-race", args: ["check:test-timeout-race-ratchet", ...argv] },
    { name: "mock-exports", args: ["check:test-mock-exports", ...argv] },
    { name: "test-lines", args: ["check:test-lines-ratchet", ...argv] },
    { name: "config-docs", args: ["config:docs:check"] },
    { name: "plugin-inventory", args: ["plugins:inventory:check"] },
  ];
  const controller = new AbortController();
  const timings: Array<{ name: string; durationMs: number; status: number }> = [];
  let next = 0;
  let stopped: number | undefined;
  const stop = (code: number) => {
    stopped ??= code;
    controller.abort();
  };
  const worker = async () => {
    while (next < checks.length) {
      if (stopped !== undefined) {
        return;
      }
      const check = checks[next++]!;
      const output: Buffer[] = [];
      const started = performance.now();
      let status = 1;
      try {
        status = await runManagedCommand({
          bin: "pnpm",
          args: check.args,
          signal: controller.signal,
          requireProcessTreeExit: true,
          stdio: ["ignore", "pipe", "pipe"],
          onReady(child) {
            child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
            child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
          },
          onSignal(signal) {
            stop(128 + constants.signals[signal]);
          },
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          output.push(Buffer.from(`${String(error)}\n`));
        }
      }
      timings.push({ name: check.name, durationMs: performance.now() - started, status });
      console.log(`::group::${check.name}`);
      process.stdout.write(Buffer.concat(output));
      console.log(
        status === 0
          ? `[ok] ${check.name}`
          : `::error title=${check.name} failed::${check.name} failed (exit ${status})`,
      );
      console.log("::endgroup::");
      if (status === 124 || status >= 128) {
        stop(status);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  printTimingSummary("baseline-ratchets", timings);
  return stopped ?? (timings.some((result) => result.status !== 0) ? 1 : 0);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
