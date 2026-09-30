#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { inspectActionsArtifactZip, sha256Digest } from "./lib/actions-artifact-archive.mjs";

const REPOSITORY = "openclaw/openclaw";
const WORKFLOW = ".github/workflows/full-release-flake-classification.yml";
const SCHEMA = "openclaw.frv-flake-classification.v1";
const RECEIPT_FILE = "frv-flake-classification.json";
const MAX_BYTES = 1024 * 1024;
const JOB_URL =
  /^https:\/\/github\.com\/openclaw\/openclaw\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/u;
const TRACKING_URL = /^https:\/\/github\.com\/openclaw\/openclaw\/(issues|pull)\/([1-9][0-9]*)$/u;
const execFileAsync = promisify(execFile);

export const RECORDED_FLAKE_DENIED_JOB_PATTERNS = Object.freeze([
  /ci[- _/]gate/iu,
  /seal|evidence/iu,
  /build[- _]artifacts/iu,
  /install[- _]smoke/iu,
  /survivor/iu,
  // This aggregate owns the published-upgrade-survivor lane.
  /^docker-seed-e2e$/iu,
  /update[- _]first[- _]hop[- _]compat|first[- _]hop/iu,
  /pack[- _]budget|npm[- _]pack|qualify[- _]release[- _]npm/iu,
  /package[- _]acceptance|package[- _]integrity/iu,
]);

export function isClassifiableFlakeJob(name) {
  return (
    typeof name === "string" &&
    name.trim() === name &&
    name.length > 0 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) &&
    !RECORDED_FLAKE_DENIED_JOB_PATTERNS.some((pattern) => pattern.test(name))
  );
}

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(`FRV flake classification: ${message}`);
  }
}

function id(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
}

function attempt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function reasonValid(value) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length >= 20 &&
    value.length <= 300 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function receiptBinding(receipt, { child, parentRunId, parentRunAttempt, targetSha } = {}) {
  requireValue(
    receipt && typeof receipt === "object" && !Array.isArray(receipt),
    "invalid receipt",
  );
  const keys = [
    "schema",
    "parentRunId",
    "parentRunAttempt",
    "child",
    "childRunId",
    "childRunAttempt",
    "targetSha",
    "jobId",
    "jobName",
    "jobUrl",
    "conclusion",
    "trackingUrl",
    "reason",
    "classifiedBy",
    "receiptRunId",
    "receiptRunAttempt",
  ];
  requireValue(
    Object.keys(receipt).length === keys.length && keys.every((key) => Object.hasOwn(receipt, key)),
    "receipt schema keys differ",
  );
  requireValue(
    receipt.schema === SCHEMA && receipt.child === "normalCi",
    "invalid receipt schema or child",
  );
  requireValue(
    [receipt.parentRunId, receipt.childRunId, receipt.jobId, receipt.receiptRunId].every(id) &&
      [receipt.parentRunAttempt, receipt.childRunAttempt, receipt.receiptRunAttempt].every(attempt),
    "invalid receipt identity",
  );
  const url = typeof receipt.jobUrl === "string" ? JOB_URL.exec(receipt.jobUrl) : null;
  requireValue(
    url?.[1] === receipt.childRunId && url?.[2] === receipt.jobId,
    "receipt job URL differs",
  );
  requireValue(
    typeof receipt.targetSha === "string" && /^[a-f0-9]{40}$/u.test(receipt.targetSha),
    "invalid target SHA",
  );
  requireValue(isClassifiableFlakeJob(receipt.jobName), "job cannot be classified");
  requireValue(["failure", "timed_out"].includes(receipt.conclusion), "job is not failed");
  requireValue(
    typeof receipt.trackingUrl === "string" && TRACKING_URL.test(receipt.trackingUrl),
    "invalid tracking URL",
  );
  requireValue(reasonValid(receipt.reason), "reason must be a single line of 20–300 characters");
  requireValue(
    typeof receipt.classifiedBy === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/u.test(receipt.classifiedBy),
    "invalid triggering actor",
  );
  requireValue(
    !child || (child.key === "normalCi" && String(child.runId) === receipt.childRunId),
    "receipt child run differs",
  );
  requireValue(
    parentRunId === undefined || receipt.parentRunId === String(parentRunId),
    "receipt parent run differs",
  );
  requireValue(
    parentRunAttempt === undefined || receipt.parentRunAttempt === parentRunAttempt,
    "receipt parent attempt differs",
  );
  requireValue(
    targetSha === undefined || receipt.targetSha === targetSha,
    "receipt target SHA differs",
  );
  return receipt;
}

export function validateFlakeClassification(receipt, expected = {}) {
  receiptBinding(receipt, expected);
  if (expected.child) {
    const matches = expected.child.jobs.filter((job) => job.name === receipt.jobName);
    const job = matches[0];
    requireValue(
      matches.length === 1 &&
        job.status === "completed" &&
        job.conclusion === receipt.conclusion &&
        (job.html_url ?? job.url) === receipt.jobUrl &&
        (job.id === undefined || String(job.id) === receipt.jobId) &&
        (job.acceptedRunAttempt ?? job.run_attempt) === receipt.childRunAttempt,
      "receipt does not match the accepted failed job",
    );
  }
  return receipt;
}

function lines(log) {
  requireValue(
    typeof log === "string" && Buffer.byteLength(log) <= MAX_BYTES,
    "job log exceeds its bound",
  );
  return log
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /u, ""));
}

export function validateFlakeGateEntries(entries) {
  requireValue(
    Array.isArray(entries) &&
      entries.length <= 100 &&
      entries.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          Object.keys(entry).length === 3 &&
          typeof entry.name === "string" &&
          typeof entry.result === "string" &&
          /^[A-Za-z0-9_-]+$/u.test(entry.name) &&
          /^[A-Za-z0-9_-]*$/u.test(entry.result) &&
          (typeof entry.selected === "boolean" ||
            (typeof entry.selected === "string" && entry.selected.length <= 30)),
      ) &&
      entries[0]?.name === "preflight" &&
      entries.at(-1)?.name === "pr-fail-fast" &&
      new Set(entries.map((entry) => entry.name)).size === entries.length,
    "CI gate log entries are missing, duplicated, or incomplete",
  );
  return entries;
}

export function parseFlakeGateEntries(log) {
  const entries = lines(log).flatMap((line) => {
    if (!/^[A-Za-z0-9_-]+: .*\(selected\b/u.test(line)) {
      return [];
    }
    const match = /^([A-Za-z0-9_-]+): (.*) \(selected=([^()]*)\)$/u.exec(line);
    requireValue(match, "CI gate log entry is malformed");
    return [
      {
        name: match[1],
        result: match[2],
        selected: match[3] === "true" ? true : match[3] === "false" ? false : match[3],
      },
    ];
  });
  return validateFlakeGateEntries(entries);
}

async function githubApi(path, { format = "json", maxBytes = MAX_BYTES, signal } = {}) {
  const { stdout } = await execFileAsync("gh", ["api", `repos/${REPOSITORY}/${path}`], {
    encoding: format === "bytes" ? null : "utf8",
    maxBuffer: maxBytes,
    timeout: 60_000,
    killSignal: "SIGKILL",
    signal,
  });
  return format === "json" ? JSON.parse(stdout) : stdout;
}

async function pages(api, path, key, signal) {
  const values = [];
  for (let page = 1; page <= 10; page++) {
    const response = await api(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      { signal },
    );
    const batch = response[key];
    requireValue(
      Array.isArray(batch) &&
        batch.length <= 100 &&
        Number.isSafeInteger(response.total_count) &&
        response.total_count <= 1000,
      "API enumeration exceeds its bound",
    );
    values.push(...batch);
    if (values.length === response.total_count) {
      requireValue(
        new Set(values.map((value) => value.id)).size === values.length,
        "API enumeration is duplicated",
      );
      return values;
    }
    requireValue(
      batch.length === 100 && values.length < response.total_count,
      "API enumeration is incomplete",
    );
  }
  throw new Error("FRV flake classification: API enumeration exceeds its bound");
}

function runIdentity(run, path) {
  requireValue(
    run?.repository?.full_name === REPOSITORY &&
      typeof run.path === "string" &&
      run.path.split("@", 1)[0] === path &&
      run.event === "workflow_dispatch",
    "workflow identity differs",
  );
}

export async function recordFlakeClassification({ inputs, env = process.env, api = githubApi }) {
  requireValue(
    env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@refs/heads/main` &&
      /^[a-f0-9]{40}$/u.test(env.GITHUB_WORKFLOW_SHA) &&
      env.GITHUB_SHA === env.GITHUB_WORKFLOW_SHA,
    "recording requires trusted main workflow",
  );
  const match = JOB_URL.exec(inputs.job_url);
  requireValue(match, "invalid job URL");
  const tracking = TRACKING_URL.exec(inputs.tracking_url);
  requireValue(tracking, "invalid tracking URL");
  requireValue(
    typeof inputs.reason === "string" && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(inputs.reason),
    "reason must be a single line of 20–300 characters",
  );
  const reason = inputs.reason.trim();
  requireValue(reasonValid(reason), "reason must be a single line of 20–300 characters");
  const [, childRunId, jobId] = match;
  const job = await api(`actions/jobs/${jobId}`);
  requireValue(
    String(job.id) === jobId &&
      String(job.run_id) === childRunId &&
      job.html_url === inputs.job_url &&
      job.status === "completed" &&
      ["failure", "timed_out"].includes(job.conclusion),
    "job is not the requested completed failure",
  );
  requireValue(isClassifiableFlakeJob(job.name), "job cannot be classified");
  const child = await api(`actions/runs/${childRunId}`);
  runIdentity(child, ".github/workflows/ci.yml");
  const parentMatch = /^CI full-release-validation-([1-9][0-9]*)-([1-9][0-9]*)-ci$/u.exec(
    child.display_title,
  );
  requireValue(String(child.id) === childRunId && parentMatch, "CI dispatch title differs");
  const [, parentRunId, parentAttempt] = parentMatch;
  const parentRunAttempt = Number(parentAttempt);
  const parent = await api(`actions/runs/${parentRunId}/attempts/${parentRunAttempt}`);
  runIdentity(parent, ".github/workflows/full-release-validation.yml");
  requireValue(
    String(parent.id) === parentRunId &&
      parent.run_attempt === parentRunAttempt &&
      parent.head_sha === child.head_sha,
    "parent run identity differs",
  );
  const jobs = await pages(
    api,
    `actions/runs/${parentRunId}/attempts/${parentRunAttempt}/jobs`,
    "jobs",
  );
  const dispatchJobs = jobs.filter((entry) => entry.name === "Run normal full CI");
  const dispatch = dispatchJobs[0];
  requireValue(
    dispatchJobs.length === 1 &&
      dispatch.status === "completed" &&
      dispatch.conclusion === "success" &&
      dispatch.run_attempt === parentRunAttempt,
    "parent CI dispatch job is not uniquely successful",
  );
  const dispatchLines = lines(await api(`actions/jobs/${dispatch.id}/logs`, { format: "text" }));
  const targets = dispatchLines.flatMap(
    (line) => /^\s+TARGET_SHA: ([a-f0-9]{40})$/u.exec(line)?.slice(1) ?? [],
  );
  const witnesses = dispatchLines.filter((line) => line.startsWith("Dispatched ci.yml: "));
  requireValue(
    targets.length === 1 &&
      witnesses.length === 1 &&
      new RegExp(
        `^Dispatched ci\\.yml: https://github\\.com/openclaw/openclaw/actions/runs/${childRunId} \\(attempt [1-9][0-9]*\\)$`,
        "u",
      ).test(witnesses[0]),
    "parent target SHA or dispatch witness differs",
  );
  const tracked = await api(`issues/${tracking[2]}`);
  requireValue(
    String(tracked.number) === tracking[2] &&
      Boolean(tracked.pull_request) === (tracking[1] === "pull"),
    "tracking issue or PR differs",
  );
  const receipt = {
    schema: SCHEMA,
    parentRunId,
    parentRunAttempt,
    child: "normalCi",
    childRunId,
    childRunAttempt: job.run_attempt,
    targetSha: targets[0],
    jobId,
    jobName: job.name,
    jobUrl: job.html_url,
    conclusion: job.conclusion,
    trackingUrl: inputs.tracking_url,
    reason,
    classifiedBy: env.GITHUB_TRIGGERING_ACTOR,
    receiptRunId: env.GITHUB_RUN_ID,
    receiptRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
  const producer = await api(`actions/runs/${receipt.receiptRunId}`);
  runIdentity(producer, WORKFLOW);
  requireValue(
    String(producer.id) === receipt.receiptRunId &&
      producer.run_attempt === receipt.receiptRunAttempt &&
      producer.head_branch === "main" &&
      producer.head_sha === env.GITHUB_WORKFLOW_SHA &&
      producer.triggering_actor?.login === receipt.classifiedBy &&
      producer.display_title === `FRV flake classification ${receipt.jobUrl}`,
    "receipt producer identity differs",
  );
  return validateFlakeClassification(receipt, {
    child: { key: "normalCi", runId: childRunId, jobs: [job] },
  });
}

export async function loadFlakeClassifications({
  repo = REPOSITORY,
  child,
  parentRunId,
  parentRunAttempt,
  targetSha,
  api = githubApi,
  signal,
}) {
  requireValue(repo === REPOSITORY, "repository differs");
  if (
    child.key !== "normalCi" ||
    !child.jobs.some(
      (job) =>
        job.status === "completed" &&
        ["failure", "timed_out"].includes(job.conclusion) &&
        isClassifiableFlakeJob(job.name),
    )
  ) {
    return {};
  }
  requireValue(
    id(parentRunId) && attempt(parentRunAttempt) && /^[a-f0-9]{40}$/u.test(targetSha),
    "loader requires exact parent and candidate bindings",
  );
  const runs = await pages(
    api,
    `actions/workflows/full-release-flake-classification.yml/runs?event=workflow_dispatch&branch=main&status=success`,
    "workflow_runs",
    signal,
  );
  const prefix = `FRV flake classification https://github.com/${REPOSITORY}/actions/runs/${child.runId}/job/`;
  const receipts = new Map();
  for (const listed of runs.filter((run) => String(run.display_title).startsWith(prefix))) {
    const run = await api(`actions/runs/${listed.id}`, { signal });
    runIdentity(run, WORKFLOW);
    requireValue(
      run.id === listed.id &&
        run.head_branch === "main" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        /^\d+$/u.test(run.display_title.slice(prefix.length)) &&
        run.display_title.startsWith(prefix),
      "receipt workflow run differs",
    );
    const artifacts = await api(`actions/runs/${run.id}/artifacts?per_page=100`, { signal });
    requireValue(
      artifacts.total_count === 1 && artifacts.artifacts?.length === 1,
      "receipt run must have one artifact",
    );
    const artifact = artifacts.artifacts[0];
    const jobId = run.display_title.slice(prefix.length);
    requireValue(
      artifact.name === `frv-flake-classification-${child.runId}-${jobId}` &&
        artifact.expired === false &&
        String(artifact.workflow_run?.id) === String(run.id) &&
        Number.isSafeInteger(artifact.size_in_bytes) &&
        artifact.size_in_bytes > 0 &&
        artifact.size_in_bytes <= MAX_BYTES,
      "receipt artifact identity differs",
    );
    const bytes = await api(`actions/artifacts/${artifact.id}/zip`, {
      format: "bytes",
      maxBytes: MAX_BYTES,
      signal,
    });
    requireValue(
      bytes.length === artifact.size_in_bytes && sha256Digest(bytes) === artifact.digest,
      "receipt artifact digest differs",
    );
    const files = inspectActionsArtifactZip(bytes, [RECEIPT_FILE], {
      maxArchiveBytes: MAX_BYTES,
      maxExpandedBytes: MAX_BYTES,
    });
    const receipt = receiptBinding(JSON.parse(files.get(RECEIPT_FILE).toString("utf8")), {
      child,
      parentRunId,
      parentRunAttempt,
      targetSha,
    });
    requireValue(
      receipt.receiptRunId === String(run.id) &&
        receipt.receiptRunAttempt === run.run_attempt &&
        receipt.jobId === jobId &&
        receipt.classifiedBy === run.triggering_actor?.login,
      "receipt producer differs",
    );
    // A rerun executes a new job ID; its predecessor's authenticated receipt is historical only.
    if (!child.jobs.some((job) => (job.html_url ?? job.url) === receipt.jobUrl)) {
      continue;
    }
    validateFlakeClassification(receipt, { child, parentRunId, parentRunAttempt, targetSha });
    const previous = receipts.get(receipt.jobId);
    if (!previous || BigInt(receipt.receiptRunId) > BigInt(previous.receiptRunId)) {
      receipts.set(receipt.jobId, receipt);
    }
  }
  if (receipts.size === 0) {
    return {};
  }
  const flakeClassifications = [...receipts.values()].toSorted((left, right) =>
    left.jobName === right.jobName ? 0 : left.jobName < right.jobName ? -1 : 1,
  );
  const gates = child.jobs.filter((job) => job.name === "openclaw/ci-gate");
  let gateEntries;
  if (gates.length === 1 && gates[0].status === "completed" && gates[0].conclusion === "failure") {
    const gate = gates[0];
    const match = JOB_URL.exec(gate.html_url ?? gate.url);
    requireValue(match?.[1] === String(child.runId), "CI gate URL differs");
    gateEntries = parseFlakeGateEntries(
      await api(`actions/jobs/${match[2]}/logs`, { format: "text", maxBytes: MAX_BYTES, signal }),
    );
  }
  return { flakeClassifications, ...(gateEntries ? { gateEntries } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireValue(
      process.argv[2] === "record",
      "usage: full-release-flake-classification.mjs record",
    );
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const receipt = await recordFlakeClassification({ inputs: event.inputs });
    const path = `${process.env.RUNNER_TEMP}/${RECEIPT_FILE}`;
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `receipt_path=${path}\nartifact_name=frv-flake-classification-${receipt.childRunId}-${receipt.jobId}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
