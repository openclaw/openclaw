import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let interruptsModuleUrl: string;

beforeAll(async () => {
  const bundlePath = path.join(tempDirs.make("mantis-cli-interrupts-"), "cli-interrupts.mjs");
  // Bundle once so cold tsx loading cannot consume the child's readiness budget.
  await esbuild({
    bundle: true,
    entryPoints: [path.resolve("extensions/qa-lab/src/mantis/cli-interrupts.ts")],
    format: "esm",
    outfile: bundlePath,
    platform: "node",
    target: "node24",
    tsconfig: path.resolve("tsconfig.json"),
  });
  interruptsModuleUrl = pathToFileURL(bundlePath).href;
});

it.skipIf(process.platform === "win32").concurrent.for([
  { signal: "SIGINT", code: 130 },
  { signal: "SIGTERM", code: 143 },
  { signal: "SIGHUP", code: 129 },
] as const)(
  "keeps repeated $signal ownership until Mantis cleanup completes",
  async ({ signal, code }, { signal: testSignal }) => {
    const script = `
      import { writeSync } from "node:fs";
      import { runWithMantisCliInterrupts } from ${JSON.stringify(interruptsModuleUrl)};

      const keepalive = setInterval(() => {}, 1_000);
      const cleanupReleased = new Promise(resolve => process.stdin.once("data", resolve));
      try {
        await runWithMantisCliInterrupts(async (signal) => {
          writeSync(1, "ready\\n");
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          writeSync(1, "cleanup-started\\n");
          await cleanupReleased;
          writeSync(1, "cleanup-complete\\n");
          throw signal.reason;
        });
      } finally {
        clearInterval(keepalive);
      }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: path.resolve("."),
      env: { ...process.env, VITEST: undefined },
      stdio: ["pipe", "pipe", "inherit", "ipc"],
    });
    assert(child.stdin && child.stdout, "Mantis child must expose its configured pipes");
    const grace = Promise.withResolvers<unknown>();
    child.once("message", grace.resolve);
    const ready = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) {
        ready.resolve();
      }
      if (stdout.includes("cleanup-started\n")) {
        cleanupStarted.resolve();
      }
    });
    const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    const closed = exit.promise;
    child.once("error", exit.reject);
    child.once("close", (exitCode, exitSignal) =>
      exit.resolve({ code: exitCode, signal: exitSignal }),
    );
    void closed.catch(() => undefined);
    const waitFor = <T>(marker: Promise<T>, name: string) =>
      withinTest(
        awaitGateBeforeSettlement(marker, closed, `timeout waiting for child marker: ${name}`),
        testSignal,
      );
    try {
      await waitFor(ready.promise, "ready");
      expect(await waitFor(grace.promise, "shutdown grace")).toEqual({
        graceMs: 125_000,
        type: "openclaw:shutdown-grace",
      });
      expect(child.kill(signal)).toBe(true);
      await waitFor(cleanupStarted.promise, "cleanup-started");
      expect(child.kill(signal)).toBe(true);
      child.stdin.end("release cleanup\n");
      const outcome = await withinTest(closed, testSignal);
      expect(stdout).toContain("cleanup-complete\n");
      expect(outcome).toEqual({ code, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
);
