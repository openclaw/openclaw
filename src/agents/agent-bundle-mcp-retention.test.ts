import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runVitestShutdownCommand } from "../../test/helpers/vitest-shutdown-command.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());
const repoRoot = path.resolve(import.meta.dirname, "../..");

it(
  "does not retain memory-session MCP runtimes across shared-worker files",
  ({ signal }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const root = fixture.createTempDir("mcp-retention-");
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
config.cacheDir = ${JSON.stringify(path.join(root, ".vite"))};
Object.assign(config.test, {
    include: [memoryTest, "src/agents/cli-runner/bundle-mcp.requester-lifecycle.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
    passWithNoTests: false,
    sequence: { sequencer: MemoryBeforeRequesterSequencer },
});
export default config;
`,
      );
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(VITEST|OPENCLAW_VITEST)|^GITHUB_ACTIONS$/.test(key),
          ),
        ),
        OPENCLAW_VITEST_RUNTIME: process.versions.bun ? "bun" : "node",
        ...(process.versions.bun ? { OPENCLAW_BUN_PATH: process.execPath } : {}),
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "modules"),
        NO_COLOR: "1",
      };
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
      const resultFor = (suffix: string) =>
        expectDefined(
          report.testResults.find((file) => file.name.endsWith(suffix)),
          suffix,
        );
      expect(
        resultFor("agent-runner-memory.private-transcript.test.ts").endTime,
      ).toBeLessThanOrEqual(resultFor("bundle-mcp.requester-lifecycle.test.ts").startTime);
    }),
  // A cold nested Vitest run of both files takes over 180s on loaded 4-CPU hosts.
  600_000,
);
