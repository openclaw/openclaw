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
afterAll(() => receipts?.close());
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
  const settled = Promise.resolve(operation)
    .then(
      () => new Error(`Operation settled while waiting for ${recordPath}`),
      (error: unknown) => error,
    )
    .then(async (error: unknown) => {
      if (!(await recorded())) {
        throw error;
      }
    });
  await Promise.race([receipts.waitFor(recordPath, "ready"), settled]);
}

async function writeCatalog(repoRoot: string, script: string) {
  await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "dist", "index.js"), script, "utf8");
}

async function abortedCatalog(signal: AbortSignal, cleanExit: boolean) {
  const repoRoot = await makeTempDir("openclaw-qa-model-catalog-");
  const pidPath = path.join(repoRoot, "descendant.pid");
  const cleanupPath = path.join(repoRoot, "descendant.cleanup");
  const controller = new AbortController();
  let descendantPid: number | undefined;
  let runPromise: ReturnType<typeof loadQaRunnerModelOptions> | undefined;
  const childScript = [
    fixtureReceiptClientSource(receipts.endpoint),
    "import fs from 'node:fs';",
    ...(cleanExit
      ? [
          "process.on('SIGTERM', () => {",
          "  setTimeout(() => {",
          `    fs.writeFileSync(${JSON.stringify(cleanupPath)}, 'clean');`,
          "    process.exit(0);",
          "  }, 75);",
          "});",
        ]
      : ["process.on('SIGTERM', () => {});"]),
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    `sendReceipt(${JSON.stringify(pidPath)}, 'ready');`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  try {
    await writeCatalog(
      repoRoot,
      [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    runPromise = loadQaRunnerModelOptions({ repoRoot, signal: controller.signal });
    // Readiness follows both the signal handler and the complete PID write.
    await withinTest(fixtureReadyBeforeSettlement(pidPath, runPromise), signal);
    descendantPid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
    expect(isProcessAlive(descendantPid)).toBe(true);
    const startedAt = Date.now();
    controller.abort();
    await expect(withinTest(runPromise, signal)).rejects.toThrow("qa model catalog aborted");
    if (cleanExit) {
      expect(await fs.readFile(cleanupPath, "utf8")).toBe("clean");
      // The grace window is 300ms; allow loaded runners, not a fixed kill ceiling.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    }
    await waitForDead(descendantPid);
  } finally {
    controller.abort();
    await runPromise?.catch(() => undefined);
    if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    await fs.rm(repoRoot, { force: true, recursive: true });
  }
}

describe("qa runner model catalog", () => {
  it("filters catalog output and prefers gpt-5.6-luna first", async () => {
    const repoRoot = await makeTempDir("openclaw-qa-model-catalog-output-");
    const model = (key: string, name: string, input = "text", available = true) => ({
      key,
      name,
      input,
      available,
      missing: false,
    });
    const models = [
      null,
      model("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6"),
      model("openai/gpt-5.6-luna", "gpt-5.6-luna", "text,image"),
      model("openrouter/auto", "OpenRouter Auto", "text", false),
    ];
    await writeCatalog(
      repoRoot,
      `process.stdout.write(${JSON.stringify(JSON.stringify({ models }))});\n`,
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
    await writeCatalog(repoRoot, `process.stdout.write("{not json");\n`);

    await expect(loadQaRunnerModelOptions({ repoRoot })).rejects.toThrow(
      "qa model catalog returned malformed JSON",
    );
  });

  it.runIf(process.platform !== "win32").for([false, true])(
    "cleans up aborted catalog descendants (graceful exit: %s)",
    async (cleanExit, { signal }) => abortedCatalog(signal, cleanExit),
  );
});
