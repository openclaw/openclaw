// Qa Lab tests cover model catalog plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadQaRunnerModelOptions } from "./model-catalog.runtime.js";
import { isProcessAlive, waitForDead } from "./process-wait.test-helper.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});
afterEach(cleanup);

async function fixtureReadyBeforeSettlement(
  recordPath: string,
  operation: PromiseLike<unknown>,
): Promise<void> {
  const recorded = () =>
    fs.readFile(recordPath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
  // A receipt can arrive after the operation settles; the fixture writes this
  // record before reporting readiness, so the durable fact wins that race.
  const settled = Promise.resolve(operation).then(
    async () => {
      if (!(await recorded())) {
        throw new Error(`Operation settled while waiting for ${recordPath}`);
      }
    },
    async (error: unknown) => {
      if (!(await recorded())) {
        throw error;
      }
    },
  );
  await Promise.race([receipts.waitFor(recordPath, "ready"), settled]);
}

describe("qa runner model catalog", () => {
  it("filters catalog output and prefers gpt-5.6-luna first", async () => {
    const repoRoot = await makeTempDir("openclaw-qa-model-catalog-output-");
    await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "dist", "index.js"),
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          models: [
            null,
            {
              key: "anthropic/claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
              input: "text",
              available: true,
              missing: false,
            },
            {
              key: "openai/gpt-5.6-luna",
              name: "gpt-5.6-luna",
              input: "text,image",
              available: true,
              missing: false,
            },
            {
              key: "openrouter/auto",
              name: "OpenRouter Auto",
              input: "text",
              available: false,
              missing: false,
            },
          ],
        }),
      )});\n`,
      "utf8",
    );

    await expect(loadQaRunnerModelOptions({ repoRoot })).resolves.toEqual([
      expect.objectContaining({ key: "openai/gpt-5.6-luna", provider: "openai" }),
      expect.objectContaining({
        key: "anthropic/claude-sonnet-4-6",
        provider: "anthropic",
      }),
    ]);
  });

  it("reports malformed catalog JSON with an owned error", async () => {
    const repoRoot = await makeTempDir("openclaw-qa-model-catalog-malformed-");
    await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "dist", "index.js"),
      `process.stdout.write("{not json");\n`,
      "utf8",
    );

    await expect(loadQaRunnerModelOptions({ repoRoot })).rejects.toThrow(
      "qa model catalog returned malformed JSON",
    );
  });

  it.runIf(process.platform !== "win32")(
    "kills aborted catalog process groups when the catalog child exits first",
    async ({ signal }) => {
      const repoRoot = await makeTempDir("openclaw-qa-model-catalog-");
      const pidPath = path.join(repoRoot, "descendant.pid");
      let descendantPid: number | undefined;
      const controller = new AbortController();
      let runPromise: ReturnType<typeof loadQaRunnerModelOptions> | undefined;
      const childScript = [
        fixtureReceiptClientSource(receipts.endpoint),
        "import fs from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        `sendReceipt(${JSON.stringify(pidPath)}, 'ready');`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const catalogScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      try {
        await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
        await fs.writeFile(path.join(repoRoot, "dist", "index.js"), catalogScript, "utf8");
        runPromise = loadQaRunnerModelOptions({
          repoRoot,
          signal: controller.signal,
        });

        await withinTest(fixtureReadyBeforeSettlement(pidPath, runPromise), signal);
        descendantPid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
        expect(isProcessAlive(descendantPid)).toBe(true);
        controller.abort();

        await expect(withinTest(runPromise, signal)).rejects.toThrow("qa model catalog aborted");
        await waitForDead(descendantPid);
      } finally {
        controller.abort();
        await runPromise?.catch(() => undefined);
        if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await fs.rm(repoRoot, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves abort grace when catalog descendants exit cleanly",
    async ({ signal }) => {
      const repoRoot = await makeTempDir("openclaw-qa-model-catalog-clean-");
      const readyPath = path.join(repoRoot, "descendant.ready");
      const cleanupPath = path.join(repoRoot, "descendant.cleanup");
      const pidPath = path.join(repoRoot, "descendant.pid");
      let descendantPid: number | undefined;
      const controller = new AbortController();
      let runPromise: ReturnType<typeof loadQaRunnerModelOptions> | undefined;
      const childScript = [
        fixtureReceiptClientSource(receipts.endpoint),
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        `    fs.writeFileSync(${JSON.stringify(cleanupPath)}, 'clean');`,
        "    process.exit(0);",
        "  }, 75);",
        "});",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        `sendReceipt(${JSON.stringify(readyPath)}, 'ready');`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const catalogScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      try {
        await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
        await fs.writeFile(path.join(repoRoot, "dist", "index.js"), catalogScript, "utf8");
        runPromise = loadQaRunnerModelOptions({
          repoRoot,
          signal: controller.signal,
        });

        // The ready marker lands after the SIGTERM handler is installed, and the
        // pid file is fully written before it, so this read is parse-safe.
        await withinTest(fixtureReadyBeforeSettlement(readyPath, runPromise), signal);
        descendantPid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
        const abortStartedAt = Date.now();
        controller.abort();

        await expect(withinTest(runPromise, signal)).rejects.toThrow("qa model catalog aborted");
        expect(await fs.readFile(cleanupPath, "utf8")).toBe("clean");
        // Abort must settle with the exiting descendants (grace window is 300ms),
        // never a long fixed kill ceiling; generous bound for loaded runners.
        expect(Date.now() - abortStartedAt).toBeLessThan(5_000);
        await waitForDead(descendantPid);
      } finally {
        controller.abort();
        await runPromise?.catch(() => undefined);
        if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await fs.rm(repoRoot, { force: true, recursive: true });
      }
    },
  );
});
