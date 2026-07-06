#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseReleaseVersion } from "./lib/npm-publish-plan.mjs";

const CORE_WORKFLOW_NAME = "OpenClaw NPM Release";
const PUBLISH_STEP = "Publish";
const READBACK_STEP = "Verify extended-stable registry readback";
const MAX_SNAPSHOT_BYTES = 128 * 1024;
const NON_FAILURE_CONCLUSIONS = new Set(["success", "skipped"]);

function assertRunIdentity(run, { expectedBranch, expectedSha }, label) {
  const expected = {
    workflowName: CORE_WORKFLOW_NAME,
    event: "workflow_dispatch",
    status: "completed",
    headBranch: expectedBranch,
    headSha: expectedSha,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (run?.[key] !== value) {
      throw new Error(
        `Referenced ${label} run must have ${key}=${value}, got ${run?.[key] ?? "<missing>"}.`,
      );
    }
  }
}

export function validateExtendedStableCoreRun({ run, jobs }, expected) {
  assertRunIdentity(run, expected, "core");
  if (run.conclusion === "success") {
    return { mode: "success" };
  }
  if (run.conclusion !== "failure") {
    throw new Error(
      `Referenced core run conclusion must be success or failure, got ${run.conclusion ?? "<missing>"}.`,
    );
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error("Failed core run validation requires its complete job list.");
  }
  const publishJobs = jobs.filter((job) => job.steps?.some((step) => step.name === PUBLISH_STEP));
  if (publishJobs.length !== 1) {
    throw new Error("Failed core run must contain exactly one publish job.");
  }
  const [publishJob] = publishJobs;
  if (publishJob.conclusion !== "failure") {
    throw new Error("Failed core run is not the single bounded publish-job readback failure.");
  }
  for (const job of jobs) {
    if (job !== publishJob && !NON_FAILURE_CONCLUSIONS.has(job.conclusion)) {
      throw new Error(
        `Failed core run contains an unexpected ${job.conclusion ?? "missing"} job conclusion.`,
      );
    }
    if (job !== publishJob) {
      for (const step of job.steps ?? []) {
        if (!NON_FAILURE_CONCLUSIONS.has(step.conclusion)) {
          throw new Error(
            `Failed core run contains an unexpected ${step.conclusion ?? "missing"} step conclusion.`,
          );
        }
      }
    }
  }
  const publishSteps = publishJob.steps.filter((step) => step.name === PUBLISH_STEP);
  const readbackSteps = publishJob.steps.filter((step) => step.name === READBACK_STEP);
  if (publishSteps.length !== 1 || readbackSteps.length !== 1) {
    throw new Error("Failed core run must contain exactly one publish and one readback step.");
  }
  const [publishStep] = publishSteps;
  const [readbackStep] = readbackSteps;
  if (publishStep?.conclusion !== "success" || readbackStep?.conclusion !== "failure") {
    throw new Error(
      "Failed core run is accepted only when publish succeeded and registry readback was the only failed step.",
    );
  }
  for (const step of publishJob.steps) {
    if (step !== readbackStep && !NON_FAILURE_CONCLUSIONS.has(step.conclusion)) {
      throw new Error(
        `Failed core run contains an unexpected ${step.conclusion ?? "missing"} step conclusion.`,
      );
    }
  }
  return { mode: "published-readback-failed" };
}

export function validateExtendedStablePreflightRun(
  { run, jobs, artifacts },
  { expectedBranch, expectedSha, expectedArtifactName },
) {
  assertRunIdentity(run, { expectedBranch, expectedSha }, "preflight");
  if (run.conclusion !== "success") {
    throw new Error(
      `Referenced preflight run conclusion must be success, got ${run.conclusion ?? "<missing>"}.`,
    );
  }
  if (!Array.isArray(jobs)) {
    throw new Error("Referenced preflight run is missing its job list.");
  }
  const jobsByName = new Map(jobs.map((job) => [job.name, job]));
  if (jobsByName.size !== jobs.length) {
    throw new Error("Referenced preflight run contains duplicate job names.");
  }
  const expectedJobs = new Map([
    ["preflight_openclaw_npm", "success"],
    ["validate_publish_request", "skipped"],
    ["publish_openclaw_npm", "skipped"],
  ]);
  if (jobsByName.size !== expectedJobs.size) {
    throw new Error("Referenced preflight run contains an unexpected job set.");
  }
  for (const [name, conclusion] of expectedJobs) {
    if (jobsByName.get(name)?.conclusion !== conclusion) {
      throw new Error(`Referenced preflight run requires ${name}=${conclusion}.`);
    }
  }
  if (!Array.isArray(artifacts)) {
    throw new Error("Referenced preflight run is missing its artifact list.");
  }
  const matches = artifacts.filter((artifact) => artifact.name === expectedArtifactName);
  if (
    matches.length !== 1 ||
    matches[0].expired !== false ||
    !Number.isSafeInteger(matches[0].id) ||
    matches[0].id < 1
  ) {
    throw new Error(
      `Referenced preflight run requires one unexpired ${expectedArtifactName} artifact.`,
    );
  }
  return { artifactId: matches[0].id };
}

export function validateLaterMonthLatest(latest, extendedStableVersion) {
  const parsedLatest = parseReleaseVersion(latest);
  const parsedExtendedStable = parseReleaseVersion(extendedStableVersion);
  if (parsedLatest === null || parsedLatest.channel !== "stable" || parsedLatest.patch >= 33) {
    throw new Error(
      `openclaw@latest must be a stable final or correction with base patch below 33; got ${latest}.`,
    );
  }
  if (
    parsedExtendedStable === null ||
    parsedExtendedStable.channel !== "stable" ||
    parsedExtendedStable.correctionNumber !== undefined
  ) {
    throw new Error(
      `Extended-stable closeout requires an exact final YYYY.M.P version; got ${extendedStableVersion}.`,
    );
  }
  const latestMonth = parsedLatest.year * 12 + parsedLatest.month;
  const extendedStableMonth = parsedExtendedStable.year * 12 + parsedExtendedStable.month;
  if (latestMonth <= extendedStableMonth) {
    throw new Error(
      `openclaw@latest must be in a later calendar month than ${extendedStableVersion}; got ${latest}.`,
    );
  }
  return latest;
}

function validateBaseline(baseline, { expectedVersion, expectedSha }) {
  if (
    baseline?.schemaVersion !== 1 ||
    baseline.version !== expectedVersion ||
    baseline.sourceSha !== expectedSha ||
    typeof baseline.latest !== "string" ||
    baseline.latest.length === 0 ||
    typeof baseline.previousExtendedStable !== "string" ||
    baseline.previousExtendedStable.length === 0
  ) {
    throw new Error(
      "Extended-stable selector baseline does not match the release version and source SHA.",
    );
  }
}

function normalizePlugins(plan, expectedVersion) {
  if (!Array.isArray(plan?.all)) {
    throw new Error("Canonical all-publishable plugin plan is missing its all array.");
  }
  const plugins = plan.all.map((plugin) => {
    if (
      typeof plugin?.packageName !== "string" ||
      plugin.packageName.length === 0 ||
      plugin.version !== expectedVersion
    ) {
      throw new Error(
        "Canonical all-publishable plugin plan contains an invalid package or version.",
      );
    }
    return { packageName: plugin.packageName, version: plugin.version };
  });
  if (plugins.length === 0) {
    throw new Error("Canonical all-publishable plugin plan must not be empty.");
  }
  plugins.sort((left, right) => left.packageName.localeCompare(right.packageName));
  if (new Set(plugins.map((plugin) => plugin.packageName)).size !== plugins.length) {
    throw new Error("Canonical all-publishable plugin plan contains duplicate package names.");
  }
  return plugins;
}

async function readRegistryPackage({ packageName, expectedVersion, query }) {
  const exactResult = await query(`${packageName}@${expectedVersion}`);
  const taggedResult = await query(`${packageName}@extended-stable`);
  return {
    packageName,
    exact: exactResult.status === 0 ? exactResult.stdout.trim() : "missing",
    extendedStable: taggedResult.status === 0 ? taggedResult.stdout.trim() : "missing",
  };
}

export async function verifyExtendedStableCloseout({
  expectedVersion,
  expectedSha,
  baseline,
  plan,
  query,
  sleep,
  attempts = 12,
  delayMs = 10_000,
}) {
  validateBaseline(baseline, { expectedVersion, expectedSha });
  validateLaterMonthLatest(baseline.latest, expectedVersion);
  const plugins = normalizePlugins(plan, expectedVersion);
  const packageNames = ["openclaw", "@openclaw/ai", ...plugins.map((plugin) => plugin.packageName)];
  let lastReadback = [];
  let latest = "missing";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastReadback = [];
    for (const packageName of packageNames) {
      lastReadback.push(await readRegistryPackage({ packageName, expectedVersion, query }));
    }
    const latestResult = await query("openclaw@latest");
    latest = latestResult.status === 0 ? latestResult.stdout.trim() : "missing";
    const packagesMatch = lastReadback.every(
      (item) => item.exact === expectedVersion && item.extendedStable === expectedVersion,
    );
    if (packagesMatch && latest === baseline.latest) {
      const byName = new Map(lastReadback.map((item) => [item.packageName, item]));
      return {
        schemaVersion: 1,
        version: expectedVersion,
        corePackages: [byName.get("openclaw"), byName.get("@openclaw/ai")].toSorted((left, right) =>
          left.packageName.localeCompare(right.packageName),
        ),
        latest,
        plugins: plugins.map((plugin) => byName.get(plugin.packageName)),
      };
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  const mismatches = lastReadback
    .filter((item) => item.exact !== expectedVersion || item.extendedStable !== expectedVersion)
    .map(
      (item) => `${item.packageName}(exact=${item.exact},extended-stable=${item.extendedStable})`,
    )
    .join(", ");
  throw new Error(
    `npm registry did not satisfy extended-stable closeout after ${attempts} attempts (packages=${mismatches || "ok"}, latest=${latest}, expected-latest=${baseline.latest}).`,
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "verify-core-run") {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    const result = validateExtendedStableCoreRun(payload, {
      expectedBranch: process.env.EXPECTED_EXTENDED_STABLE_BRANCH,
      expectedSha: process.env.EXPECTED_RELEASE_SHA,
    });
    console.log(`Verified referenced core run (${result.mode}).`);
    return;
  }
  if (command === "verify-preflight-run") {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    const result = validateExtendedStablePreflightRun(payload, {
      expectedBranch: process.env.EXPECTED_EXTENDED_STABLE_BRANCH,
      expectedSha: process.env.EXPECTED_RELEASE_SHA,
      expectedArtifactName: process.env.EXPECTED_PREFLIGHT_ARTIFACT,
    });
    console.log(`Verified referenced preflight run artifact ${result.artifactId}.`);
    return;
  }
  if (command === "verify-registry") {
    const expectedVersion = (process.env.EXPECTED_VERSION ?? "").replace(/^v/u, "");
    const snapshot = await verifyExtendedStableCloseout({
      expectedVersion,
      expectedSha: process.env.EXPECTED_RELEASE_SHA ?? "",
      baseline: JSON.parse(readFileSync(process.env.BASELINE_FILE, "utf8")),
      plan: JSON.parse(readFileSync(process.env.PLUGIN_PLAN_FILE, "utf8")),
      query: (target) => spawnSync("npm", ["view", target, "version"], { encoding: "utf8" }),
      sleep: (delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }),
    });
    const snapshotFile = process.env.SNAPSHOT_FILE ?? "extended-stable-registry-snapshot.json";
    writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    if (statSync(snapshotFile).size > MAX_SNAPSHOT_BYTES) {
      throw new Error(`Extended-stable registry snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
    }
    return;
  }
  throw new Error(`Unknown extended-stable closeout command: ${command ?? "<missing>"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`openclaw-npm-extended-stable-closeout: ${message}`);
    process.exit(1);
  }
}
