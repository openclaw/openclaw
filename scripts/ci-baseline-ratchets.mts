import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
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
    { name: "session-identity", args: ["check:session-identity-ratchet", ...argv] },
    { name: "lifetime-check", args: ["check:lifetime-check-ratchet", ...argv] },
    { name: "runtime-process-lifecycle", args: ["check:runtime-process-lifecycle", ...argv] },
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
      const started = performance.now();
      // Stream each line as it arrives: a stuck check must show its last output before a deadline.
      const prefix = (stream: Readable | null) =>
        stream &&
        createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => {
          console.log(`[${check.name}] ${line}`);
        });
      console.log(`[${check.name}] started`);
      let status = 1;
      try {
        status = await runManagedCommand({
          bin: "pnpm",
          args: check.args,
          signal: controller.signal,
          requireProcessTreeExit: true,
          stdio: ["ignore", "pipe", "pipe"],
          onReady(child) {
            prefix(child.stdout);
            prefix(child.stderr);
          },
          onSignal(signal) {
            stop(128 + constants.signals[signal]);
          },
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          console.log(`[${check.name}] ${String(error)}`);
        }
      }
      timings.push({ name: check.name, durationMs: performance.now() - started, status });
      console.log(
        status === 0
          ? `[ok] ${check.name}`
          : `::error title=${check.name} failed::${check.name} failed (exit ${status})`,
      );
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
