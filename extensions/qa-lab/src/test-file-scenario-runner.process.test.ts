import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  QA_CHILD_STDERR_TAIL_BYTES as STDERR_LIMIT,
  QA_CHILD_STDOUT_MAX_BYTES as STDOUT_LIMIT,
} from "./child-output.js";
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
afterEach(() => harness.cleanup());
async function scriptFixture(name: string, script: string) {
  const root = await harness.makeTempDir("qa-script-");
  const scriptPath = path.join(root, name);
  await fs.writeFile(scriptPath, script);
  const scenario = makeTestFileScenario("script", scriptPath);
  const options = {
    ...QA_TEST_RUNNER_DEFAULTS,
    repoRoot: process.cwd(),
    outputDir: path.join(root, "out"),
    scenarios: [scenario],
  };
  return { root, scenario, options };
}

it.each([true, false])("streams native output before settlement (bounded: %s)", async (bounded) => {
  const exitCode = bounded ? 7 : 0;
  const script = bounded
    ? `process.stdout.write('x'.repeat(${STDOUT_LIMIT * 2})); process.stderr.write('🦞'.repeat(${STDERR_LIMIT / 2 + 1}) + '\\nfinal diagnostic\\n');`
    : "process.stdout.write('native stdout'); process.stderr.write('native stderr');";
  const streamed = { stdout: 0, stderr: 0 };
  let settled = false;
  const result = await runQaScenarioCommandLifecycle({
    command: process.execPath,
    args: ["-e", `${script} process.exitCode = ${exitCode};`],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5_000,
    onOutput: (stream, chunk) => {
      expect(settled).toBe(false);
      streamed[stream] += chunk.byteLength;
      if (!bounded) {
        expect(chunk.toString("utf8")).toBe(`native ${stream}`);
      }
    },
  });
  settled = true;
  expect(result.exitCode).toBe(exitCode);
  expect(result.failureMessage).toBeUndefined();
  if (bounded) {
    expect(Buffer.byteLength(result.stdout)).toBe(STDOUT_LIMIT);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(STDERR_LIMIT);
    expect(result).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
    const log = formatQaScenarioCommandOutput(result);
    expect(log.startsWith("[stdout truncated to first")).toBe(true);
    expect(log).toContain("[stderr truncated to last");
    expect(result.stderr).toContain("final diagnostic");
    expect(result.stderr).not.toContain("�");
    expect(streamed).toEqual({
      stdout: STDOUT_LIMIT * 2,
      stderr: STDERR_LIMIT * 2 + 4 + Buffer.byteLength("\nfinal diagnostic\n"),
    });
  } else {
    expect(streamed).toEqual({ stdout: 13, stderr: 13 });
    expect(result).toMatchObject({ stdout: "native stdout", stderr: "native stderr" });
  }
});

it("dispatches explicit checkout and external artifact roots to a real script", async () => {
  const { root, scenario, options } = await scriptFixture(
    "roots.mjs",
    `import fs from 'node:fs/promises';
await fs.mkdir(process.argv[3], {recursive:true});
await fs.writeFile(process.argv[4], JSON.stringify({repo:process.argv[2], cwd:process.cwd(), out:process.argv[3]}));
await fs.writeFile(process.argv[3] + '/qa-evidence.json', ${JSON.stringify(JSON.stringify(buildScriptProducerEvidence({ status: "pass" })))});`,
  );
  if (scenario.execution.kind !== "script") {
    throw new Error("script expected");
  }
  scenario.execution.args = ["${repoRoot}", "${outputDir}", path.join(root, "roots.json")];
  const result = await runQaTestFileScenarios(options);
  const roots = JSON.parse(await fs.readFile(path.join(root, "roots.json"), "utf8"));
  expect(roots).toMatchObject({ repo: options.repoRoot, cwd: options.repoRoot });
  expect(roots.out.startsWith(options.outputDir + path.sep)).toBe(true);
  expect(path.basename(roots.out)).toBe(scenario.id);
  expect(result.results[0]?.status).toBe("pass");
});

it("fails script scenarios that exit cleanly after timeout termination", async () => {
  const { options } = await scriptFixture(
    "clean-exit-after-timeout.ts",
    "process.stdout.write('waiting for timeout\\n'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
  );
  const result = await runQaTestFileScenarios({ ...options, commandTimeoutMs: 100 });
  expect(result.results[0]).toMatchObject({
    status: "fail",
    failureMessage: expect.stringMatching(/timed out after 100ms/u),
  });
});
