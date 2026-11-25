import { spawn } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Run through the repository wrapper so each sample has fresh Gateway/test state.
const [outputDirectory, count = "20"] = process.argv.slice(2);
const samples = Number(count);
if (!outputDirectory || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error("Usage: node scripts/perf/repeat-cron-test.mjs <existing-output-dir> [samples]");
}
const results = [];
for (let sample = 1; sample <= samples; sample += 1) {
  const log = await open(path.join(outputDirectory, `sample-${sample}.log`), "wx");
  const load = os.loadavg();
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["scripts/run-vitest.mjs", "src/gateway/server.cron.test.ts", "--maxWorkers=1"],
        { stdio: ["ignore", log.fd, log.fd] },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(signal ?? code));
    });
  } finally {
    await log.close();
  }
  results.push({ sample, load, exitCode });
  await writeFile(path.join(outputDirectory, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Sample ${sample}/${samples}: ${exitCode === 0 ? "PASS" : `FAIL (${exitCode})`}`);
}
process.exitCode = results.some((result) => result.exitCode !== 0) ? 1 : 0;
