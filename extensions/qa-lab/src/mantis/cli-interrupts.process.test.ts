import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
let bundleRoot: string | undefined;
let interruptsModuleUrl: string;

beforeAll(async () => {
  bundleRoot = await mkdtemp(path.join(os.tmpdir(), "mantis-cli-interrupts-"));
  const bundlePath = path.join(bundleRoot, "cli-interrupts.mjs");
  // Compile once before spawning: cold tsx loading must not consume the signal
  // child's readiness budget when the QA shard is CPU-contended.
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

afterAll(async () => {
  if (bundleRoot) {
    await rm(bundleRoot, { recursive: true, force: true });
  }
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
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ready = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) {
        ready.resolve();
      }
      if (stdout.includes("cleanup-started\n")) {
        cleanupStarted.resolve();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) =>
          resolve({ code: exitCode, signal: exitSignal }),
        );
      },
    );
    void closed.catch(() => undefined);

    try {
      await withinTest(
        awaitGateBeforeSettlement(ready.promise, closed, "timeout waiting for child marker: ready"),
        testSignal,
      );
      expect(child.kill(signal)).toBe(true);
      await withinTest(
        awaitGateBeforeSettlement(
          cleanupStarted.promise,
          closed,
          "timeout waiting for child marker: cleanup-started",
        ),
        testSignal,
      );
      expect(child.kill(signal)).toBe(true);
      child.stdin.end("release cleanup\n");
      const outcome = await withinTest(closed, testSignal);
      const diagnostics = JSON.stringify({ outcome, stderr, stdout }, null, 2);

      expect(stdout, diagnostics).toContain("cleanup-complete\n");
      expect(outcome.code, diagnostics).toBe(code);
      expect(outcome.signal, diagnostics).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
);
