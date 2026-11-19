import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runManagedCommand } from "./lib/managed-child-process.mts";

type Observation = {
  ready: boolean;
  positiveControl: boolean;
  operationsStarted: number;
  cleanup: boolean;
  verdict: string;
};
type TestReport = {
  numTotalTests: number;
  numPendingTests: number;
  numPassedTests: number;
  numFailedTests: number;
};

// Setup, interrupted commands, missing tests and failed cleanup are not incident catches.
export function classifyReplay(
  exitCode: number | null,
  observation: Observation | null,
  report: TestReport | null,
  unchanged: boolean,
) {
  if (!unchanged) {
    return "invalid-input-changed";
  }
  if (!observation || !report || report.numTotalTests !== 1 || report.numPendingTests !== 0) {
    return "blocked";
  }
  if (!observation.cleanup) {
    return "cleanup-failed";
  }
  if (!observation.ready || !observation.positiveControl || observation.operationsStarted !== 1) {
    return "blocked";
  }
  if (exitCode === 0 && report.numPassedTests === 1 && observation.verdict === "pass") {
    return "pass";
  }
  if (exitCode === 1 && report.numFailedTests === 1 && observation.verdict === "assertion-failed") {
    return "assertion-failed";
  }
  return "blocked";
}

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const root = path.resolve(import.meta.dirname, "..");
const scenarioPath = path.join(root, "test/incident-replay-201581.scenario.ts");

async function main() {
  const { values } = parseArgs({
    options: {
      checkout: { type: "string", default: root },
      revision: { type: "string" },
      output: { type: "string" },
    },
  });
  const checkout = path.resolve(values.checkout);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8", timeout: 30_000 }).trim();
  const revision = git("rev-parse", "HEAD");
  const sourcePatch = git("diff", "HEAD", "--binary");
  if (values.revision) {
    assert.match(values.revision, /^[a-f0-9]{40}$/, "Use the full expected revision");
    assert.equal(revision, values.revision, "Checkout does not match expected revision");
    assert.equal(sourcePatch, "", "Qualification requires unchanged tracked source");
  }
  const scenario = await fs.readFile(scenarioPath);
  const runnerHash = hash(await fs.readFile(import.meta.filename));
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "test/incident-replay/201581.json"), "utf8"),
  );
  assert.equal(hash(scenario), manifest.scenarioHash, "Scenario differs from its recorded inputs");
  const output = values.output
    ? path.resolve(values.output)
    : path.join(root, ".artifacts/incident-replay", randomUUID());
  // Refuse reuse so old observations can never turn a failed launch into a pass.
  await fs.mkdir(output, { recursive: false });
  const overlay = path.join(checkout, "test", "incident-replay-" + randomUUID() + ".e2e.test.ts");
  const reportPath = path.join(output, "vitest.json");
  const args = [
    "scripts/run-vitest.mjs",
    "run",
    path.relative(checkout, overlay),
    "--maxWorkers=1",
    "--reporter=json",
    "--outputFile=" + reportPath,
  ];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const log = await fs.open(path.join(output, "run.log"), "wx");
  let exitCode: number | null = null;
  let executionError: string | null = null;
  let unchanged: boolean;
  await fs.writeFile(overlay, scenario, { flag: "wx" });
  console.log("Incident #201581 at " + revision + "; logs: " + output);
  try {
    exitCode = await runManagedCommand({
      bin: process.execPath,
      args,
      cwd: checkout,
      env: { ...process.env, OPENCLAW_INCIDENT_REPLAY_OUTPUT: output },
      stdio: ["ignore", log.fd, log.fd],
      timeoutMs: 900_000,
      requireProcessTreeExit: process.platform !== "win32",
    });
  } catch (error) {
    executionError = String(error);
  } finally {
    await log.close();
    unchanged = (await fs.readFile(overlay)).equals(scenario);
    if (unchanged) {
      await fs.unlink(overlay);
    }
  }
  unchanged &&=
    git("rev-parse", "HEAD") === revision &&
    git("diff", "HEAD", "--binary") === sourcePatch &&
    (await fs.readFile(scenarioPath)).equals(scenario) &&
    hash(await fs.readFile(import.meta.filename)) === runnerHash;
  const observation: Observation | null = await fs
    .readFile(path.join(output, "observation.json"), "utf8")
    .then(JSON.parse, () => null);
  const report: TestReport | null = await fs
    .readFile(reportPath, "utf8")
    .then(JSON.parse, () => null);
  const verdict = classifyReplay(exitCode, observation, report, unchanged);
  const receipt = {
    issue: manifest.issue,
    revision,
    sourcePatchHash: sourcePatch ? hash(sourcePatch) : null,
    scenarioHash: hash(scenario),
    runnerHash,
    startedAt,
    wallMs: performance.now() - started,
    command: [process.execPath, ...args],
    exitCode,
    executionError,
    verdict,
    observation,
  };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = verdict === "pass" ? 0 : verdict === "assertion-failed" ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await fs.mkdir(path.join(root, ".artifacts/incident-replay"), { recursive: true });
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 2;
  }
}
