import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runQaSuite } from "./suite-launch.runtime.js";
import { findQaSuiteSummaryCompletionError } from "./suite-summary.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = process.argv[2];
const scenarioIds = process.argv.slice(3);

if (!outputDir || scenarioIds.length === 0) {
  throw new Error("suite process fixture requires an output directory and scenario ids");
}

const summaryPath = path.resolve(outputDir, "qa-suite-summary.json");
const rename = fs.rename;
// Atomic publication owns summary readiness, before remaining durability work.
// Forward the actual rename and report only this fixture's terminal summary.
fs.rename = async (source, target) => {
  await rename(source, target);
  if (target === summaryPath && process.connected && process.send) {
    const summary: unknown = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    if (findQaSuiteSummaryCompletionError(summary) === undefined) {
      process.send("summary-written", () => process.disconnect());
    }
  }
};

try {
  const result = await runQaSuite({
    repoRoot,
    outputDir: path.relative(repoRoot, outputDir),
    providerMode: "mock-openai",
    scenarioIds,
    concurrency: 4,
  });
  const failed = result.result.scenarios.filter((scenario) => scenario.status !== "pass");
  if (failed.length > 0) {
    throw new Error(`suite process fixture failed ${failed.length} scenario(s)`);
  }
} catch (error) {
  process.stderr.write(`${formatErrorMessage(error)}\n`);
  process.exitCode = 1;
  if (process.connected) {
    process.disconnect();
  }
} finally {
  fs.rename = rename;
}
