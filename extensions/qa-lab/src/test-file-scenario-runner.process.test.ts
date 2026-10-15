import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QA_CHILD_STDERR_TAIL_BYTES, QA_CHILD_STDOUT_MAX_BYTES } from "./child-output.js";
import {
  formatQaScenarioCommandOutput,
  runQaScenarioCommandLifecycle,
} from "./test-file-scenario-command-lifecycle.js";
import { runQaTestFileScenarios } from "./test-file-scenario-runner.js";
import {
  buildScriptProducerEvidence,
  QA_TEST_RUNNER_DEFAULTS,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
const makeTempDir = (prefix: string) => harness.makeTempDir(prefix);

afterEach(async () => {
  await harness.cleanup();
});

describe("qa test file scenario runner", () => {
  it("bounds retained child logs without changing the nonzero exit or live output", async () => {
    const exitCode = 7;

    const streamed = { stdout: 0, stderr: 0 };
    const result = await runQaScenarioCommandLifecycle({
      command: process.execPath,
      args: [
        "-e",
        [
          `process.stdout.write('x'.repeat(${QA_CHILD_STDOUT_MAX_BYTES * 2}));`,
          `process.stderr.write('🦞'.repeat(${QA_CHILD_STDERR_TAIL_BYTES / 2 + 1}) + '\\nfinal diagnostic\\n');`,
          `process.exitCode = ${exitCode};`,
        ].join("\n"),
      ],
      cwd: process.cwd(),
      env: process.env,
      onOutput: (stream, chunk) => {
        streamed[stream] += chunk.byteLength;
      },
      timeoutMs: 5_000,
    });

    expect(Buffer.byteLength(result.stdout)).toBe(QA_CHILD_STDOUT_MAX_BYTES);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(QA_CHILD_STDERR_TAIL_BYTES);
    expect(result.exitCode).toBe(exitCode);
    expect(result.failureMessage).toBeUndefined();
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    const log = formatQaScenarioCommandOutput(result);
    expect(log.startsWith("[stdout truncated to first")).toBe(true);
    expect(log.includes("[stderr truncated to last")).toBe(true);
    expect(result.stderr).toContain("final diagnostic");
    expect(result.stderr).not.toContain("�");
    expect(streamed).toEqual({
      stdout: QA_CHILD_STDOUT_MAX_BYTES * 2,
      stderr: QA_CHILD_STDERR_TAIL_BYTES * 2 + 4 + Buffer.byteLength("\nfinal diagnostic\n"),
    });
  });

  it("streams real native subprocess output before command settlement", async () => {
    const observed: Array<{ stream: "stderr" | "stdout"; value: string }> = [];
    let settled = false;
    const result = await runQaScenarioCommandLifecycle({
      command: process.execPath,
      args: ["-e", "process.stdout.write('native stdout'); process.stderr.write('native stderr')"],
      cwd: process.cwd(),
      env: process.env,
      onOutput: (stream, chunk) => {
        expect(settled).toBe(false);
        observed.push({ stream, value: chunk.toString("utf8") });
      },
      timeoutMs: 5_000,
    });
    settled = true;

    expect(observed).toEqual(
      expect.arrayContaining([
        { stream: "stdout", value: "native stdout" },
        { stream: "stderr", value: "native stderr" },
      ]),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "native stdout",
      stderr: "native stderr",
    });
  });

  it("dispatches explicit checkout and external artifact roots to a real script", async () => {
    const repoRoot = process.cwd();
    const external = await makeTempDir("qa-relocated-script-");
    const scriptPath = path.join(external, "roots.mjs");
    await fs.writeFile(
      scriptPath,
      `import fs from 'node:fs/promises';
await fs.mkdir(process.argv[3], {recursive:true});
await fs.writeFile(process.argv[4], JSON.stringify({repo:process.argv[2], cwd:process.cwd(), out:process.argv[3]}));
await fs.writeFile(process.argv[3] + '/qa-evidence.json', ${JSON.stringify(JSON.stringify(buildScriptProducerEvidence({ status: "pass" })))});`,
    );
    const scenario = makeTestFileScenario("script", scriptPath);
    if (scenario.execution.kind !== "script") {
      throw new Error("script expected");
    }
    scenario.execution.args = ["${repoRoot}", "${outputDir}", path.join(external, "roots.json")];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(external, "evidence"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [scenario],
    });
    const roots = JSON.parse(await fs.readFile(path.join(external, "roots.json"), "utf8"));
    expect(roots).toMatchObject({ repo: repoRoot, cwd: repoRoot });
    expect(roots.out.startsWith(path.join(external, "evidence") + path.sep)).toBe(true);
    expect(path.basename(roots.out)).toBe(scenario.id);
    expect(result.results[0]?.status).toBe("pass");
  });

  it("fails script scenarios that exit cleanly after timeout termination", async () => {
    const repoRoot = process.cwd();
    const tempRoot = await makeTempDir("qa-script-timeout-clean-exit-");
    const scriptPath = path.join(tempRoot, "clean-exit-after-timeout.ts");
    await fs.writeFile(
      scriptPath,
      [
        "process.stdout.write('waiting for timeout\\n');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(tempRoot, "out"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", scriptPath)],
      commandTimeoutMs: 100,
    });

    expect(result.results[0]?.status).toBe("fail");
    expect(result.results[0]?.failureMessage).toMatch(/timed out after 100ms/u);
  });
});
