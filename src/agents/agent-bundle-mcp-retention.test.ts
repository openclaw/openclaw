import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runVitestShutdownCommand } from "../../test/helpers/vitest-shutdown-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = path.resolve(import.meta.dirname, "../..");

it("does not retain memory-session MCP runtimes across shared-worker files", async ({ signal }) => {
  const root = tempDirs.make("mcp-retention-");
  const reportPath = path.join(root, "report.json");
  const configPath = path.join(root, "vitest.config.mts");
  await fs.writeFile(
    configPath,
    `import { BaseSequencer } from ${JSON.stringify(import.meta.resolve("vitest/node"))};
import { createUnitFastVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.unit-fast.config.ts"))};
const memoryTest = "src/auto-reply/reply/agent-runner-memory.private-transcript.test.ts";
class MemoryBeforeRequesterSequencer extends BaseSequencer {
  async sort(files) {
    return files.toSorted(
      (a, b) => Number(b.moduleId.endsWith(memoryTest)) - Number(a.moduleId.endsWith(memoryTest)),
    );
  }
}
const config = createUnitFastVitestConfig();
export default {
  ...config,
  test: {
    ...config.test,
    include: [memoryTest, "src/agents/cli-runner/bundle-mcp.requester-lifecycle.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
    passWithNoTests: false,
    sequence: { sequencer: MemoryBeforeRequesterSequencer },
  },
};
`,
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST") || key.startsWith("OPENCLAW_VITEST") || key === "GITHUB_ACTIONS") {
      delete env[key];
    }
  }
  env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH = path.join(root, "modules");
  env.NO_COLOR = "1";
  const result = await runVitestShutdownCommand({
    cwd: repoRoot,
    env,
    signal,
    args: [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      configPath,
      "--reporter=verbose",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
    ],
  });
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as JsonTestResults;
  expect(report.testResults).toHaveLength(2);
  for (const file of report.testResults) {
    expect(file.status).toBe("passed");
    expect(file.assertionResults.length).toBeGreaterThan(0);
    expect(file.assertionResults.every((test) => test.status === "passed")).toBe(true);
  }
  const memory = expectDefined(
    report.testResults.find((file) =>
      file.name.endsWith("agent-runner-memory.private-transcript.test.ts"),
    ),
    "memory producer result",
  );
  const requester = expectDefined(
    report.testResults.find((file) => file.name.endsWith("bundle-mcp.requester-lifecycle.test.ts")),
    "requester lifecycle result",
  );
  expect(memory.endTime).toBeLessThanOrEqual(requester.startTime);
}, 180_000);
