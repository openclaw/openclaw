#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { workflowRunsApiArgs } from "../lib/plain-gh.mjs";
import {
  isProtectedMainWorkflowPath,
  parseCrabboxGateCheckSummary,
} from "./crabbox-gate-contract.mjs";
import { execPrGh, execPrGhJson } from "./github.mjs";

const REPOSITORY = "openclaw/openclaw";
const CRABBOX_WORKFLOW = ".github/workflows/pr-crabbox-gate-publisher.yml";
const CRABBOX_CHECK = "openclaw/crabbox-gate";
const CRABBOX_CHECK_APP_ID = 15368;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

// This receipt is data, not shell code. Preparation uses this same reader before
// consuming pending provenance; a malformed new field must never be evaluated.
function readCrabboxGateReceipt() {
  const path = ".local/gates.env";
  if (!lstatSync(path).isFile()) {
    throw new Error("Crabbox gates must be a regular file.");
  }
  const contents = readFileSync(path, "utf8");
  const patterns = {
    PR_NUMBER: /^[1-9][0-9]*$/u,
    DOCS_ONLY: /^(?:true|false)$/u,
    CHANGELOG_REQUIRED: /^(?:true|false)$/u,
    GATES_MODE: /^remote_crabbox_aws(?:_pending)?$/u,
    HOSTED_GATES_TARGET_HEAD_SHA: /^$/u,
    LAST_VERIFIED_HEAD_SHA: SHA_PATTERN,
    FULL_GATES_HEAD_SHA: /^(?:[0-9a-f]{40})?$/u,
    REMOTE_GATES_PROVIDER: /^(?:aws)?$/u,
    REMOTE_GATES_RUN_ID: /^(?:run_[a-zA-Z0-9_-]+)?$/u,
    REMOTE_GATES_LEASE_ID: /^(?:cbx_[a-zA-Z0-9_-]+)?$/u,
    REMOTE_GATES_RUN_URL:
      /^(?:https:\/\/github\.com\/openclaw\/openclaw\/actions\/runs\/[1-9][0-9]*)?$/u,
    GATES_PASSED_AT: /^[0-9TZ:-]+$/u,
    REMOTE_GATES_BASE_SHA: SHA_PATTERN,
    REMOTE_GATES_WORKFLOW_SHA: SHA_PATTERN,
    REMOTE_GATES_ACTIONS_RUN_ATTEMPT: /^[1-9][0-9]*$/u,
    PENDING_CRABBOX_STATE: /^(?:dispatching|selected)$/u,
    PENDING_CRABBOX_PR: /^[1-9][0-9]*$/u,
    PENDING_CRABBOX_BASE_SHA: SHA_PATTERN,
    PENDING_CRABBOX_HEAD_SHA: SHA_PATTERN,
    PENDING_CRABBOX_ACTIONS_RUN_ID: /^[1-9][0-9]*$/u,
    PENDING_CRABBOX_ATTEMPT: /^[1-9][0-9]*$/u,
    PENDING_CRABBOX_WORKFLOW_SHA: SHA_PATTERN,
  };
  const values = new Map();
  for (const line of contents.split("\n")) {
    if (!line) {
      continue;
    }
    const match = /^([A-Z_]+)=(.*)$/u.exec(line);
    const value = match?.[2] === "''" ? "" : match?.[2];
    if (
      !match ||
      !Object.hasOwn(patterns, match[1]) ||
      values.has(match[1]) ||
      !patterns[match[1]].test(value)
    ) {
      throw new Error("Malformed Crabbox gate receipt.");
    }
    values.set(match[1], value);
  }
  positiveInteger(values.get("PR_NUMBER"));
  if (!values.has("GATES_MODE") || !values.has("LAST_VERIFIED_HEAD_SHA")) {
    throw new Error("Missing Crabbox gate identity.");
  }
  const state = values.get("PENDING_CRABBOX_STATE");
  const pending = [...values.keys()].filter((key) => key.startsWith("PENDING_CRABBOX_"));
  if (
    pending.length &&
    (values.get("GATES_MODE") !== "remote_crabbox_aws_pending" ||
      !["dispatching", "selected"].includes(state) ||
      values.get("PENDING_CRABBOX_PR") !== values.get("PR_NUMBER") ||
      !values.has("PENDING_CRABBOX_BASE_SHA") ||
      values.get("PENDING_CRABBOX_HEAD_SHA") !== values.get("LAST_VERIFIED_HEAD_SHA") ||
      pending.length !== (state === "selected" ? 7 : 4))
  ) {
    throw new Error("Malformed pending Crabbox dispatch identity.");
  }
  for (const key of [
    "PENDING_CRABBOX_ACTIONS_RUN_ID",
    "PENDING_CRABBOX_ATTEMPT",
    "REMOTE_GATES_ACTIONS_RUN_ATTEMPT",
  ]) {
    if (values.has(key)) {
      positiveInteger(values.get(key));
    }
  }
  return { path, contents, values };
}

function pendingGateReceipt(record, allowCompleted) {
  const receipt = readCrabboxGateReceipt();
  const { path, values } = receipt;
  let { contents } = receipt;
  const complete = values.get("GATES_MODE") === "remote_crabbox_aws";
  const state = complete ? "complete" : values.get("PENDING_CRABBOX_STATE");
  if (
    values.get("PR_NUMBER") !== String(record.pr) ||
    values.get("LAST_VERIFIED_HEAD_SHA") !== record.headRefOid ||
    (complete
      ? !allowCompleted || values.get("FULL_GATES_HEAD_SHA") !== record.headRefOid
      : values.get("FULL_GATES_HEAD_SHA"))
  ) {
    throw new Error("Crabbox gates do not match the published preparation.");
  }
  let selected;
  if (complete) {
    if (
      values.get("REMOTE_GATES_BASE_SHA") !== record.baseRefOid ||
      !values.has("REMOTE_GATES_WORKFLOW_SHA")
    ) {
      throw new Error("Missing completed publisher provenance.");
    }
    selected = {
      id: positiveInteger(values.get("REMOTE_GATES_RUN_URL")?.split("/").at(-1)),
      run_attempt: positiveInteger(values.get("REMOTE_GATES_ACTIONS_RUN_ATTEMPT")),
      head_sha: values.get("REMOTE_GATES_WORKFLOW_SHA"),
    };
  } else if (state) {
    if (values.get("PENDING_CRABBOX_BASE_SHA") !== record.baseRefOid) {
      throw new Error("Pending Crabbox base does not match this preparation.");
    }
    if (state === "selected") {
      selected = {
        id: positiveInteger(values.get("PENDING_CRABBOX_ACTIONS_RUN_ID")),
        run_attempt: positiveInteger(values.get("PENDING_CRABBOX_ATTEMPT")),
        head_sha: values.get("PENDING_CRABBOX_WORKFLOW_SHA"),
      };
    }
  }
  return {
    state,
    selected,
    write(run) {
      if (!lstatSync(path).isFile() || readFileSync(path, "utf8") !== contents) {
        throw new Error("Crabbox gate receipt changed during observation.");
      }
      if (complete) {
        return;
      }
      const next = {
        STATE: run ? "selected" : "dispatching",
        PR: record.pr,
        BASE_SHA: record.baseRefOid,
        HEAD_SHA: record.headRefOid,
        ...(run
          ? { ACTIONS_RUN_ID: run.id, ATTEMPT: run.run_attempt, WORKFLOW_SHA: run.head_sha }
          : {}),
      };
      const updated =
        contents
          .split("\n")
          .filter((line) => line && !line.startsWith("PENDING_CRABBOX_"))
          .join("\n") +
        "\n" +
        Object.entries(next)
          .map(([key, value]) => `PENDING_CRABBOX_${key}=${value}\n`)
          .join("");
      const temporary = `${path}.${process.pid}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      // Cleanup owns only the file we created. Preserve persistence failures even
      // when closing or removing that file also fails; dispatch must not continue.
      const errors = [];
      try {
        writeFileSync(fd, updated);
        fsyncSync(fd);
      } catch (error) {
        errors.push(error);
      }
      try {
        closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 0) {
        try {
          renameSync(temporary, path);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if (error.code !== "ENOENT") {
            errors.push(error);
          }
        }
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(
              errors,
              `Pending Crabbox receipt persistence failed: ${errors.map(String).join("; ")}`,
              { cause: errors[0] },
            );
      }
      contents = updated;
    },
  };
}

function positiveInteger(value) {
  if (!/^[1-9][0-9]*$/u.test(value ?? "") || !Number.isSafeInteger(Number(value))) {
    throw new Error("Expected a positive safe integer Actions run ID or attempt.");
  }
  return Number(value);
}

function requireCrabboxRun(record, run, selected) {
  if (
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    run.id !== selected.id ||
    run.html_url !== `https://github.com/${REPOSITORY}/actions/runs/${selected.id}` ||
    run.display_title !== `PR Crabbox gate #${record.pr} / ${record.headRefOid}` ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    !SHA_PATTERN.test(run.head_sha) ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    !isProtectedMainWorkflowPath(run.path, CRABBOX_WORKFLOW) ||
    (selected.head_sha !== undefined && run.head_sha !== selected.head_sha) ||
    (selected.run_attempt !== undefined && run.run_attempt !== selected.run_attempt)
  ) {
    throw new Error("Protected-main Crabbox publisher run identity changed or is invalid.");
  }
  return run;
}

function requirePrRecord({ baseRefOid, pr, headRefName, headRefOid, isCrossRepository }) {
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error("Expected a positive PR number.");
  }
  if (typeof headRefName !== "string" || headRefName.length === 0 || headRefName.startsWith("-")) {
    throw new Error("Expected a non-empty PR headRefName.");
  }
  if (!SHA_PATTERN.test(headRefOid) || !SHA_PATTERN.test(baseRefOid)) {
    throw new Error("Expected full PR baseRefOid and headRefOid values.");
  }
  if (isCrossRepository === true) {
    throw new Error(
      `PR #${pr} comes from a fork; release-gate workflow dispatch requires a branch in the base repository at ${headRefOid}.`,
    );
  }
}

function buildCiDispatchArgs(record, backend) {
  requirePrRecord(record);
  if (backend.name === "crabbox") {
    return [
      "workflow",
      "run",
      "pr-crabbox-gate-publisher.yml",
      "--ref",
      "main",
      "-f",
      `pr_number=${record.pr}`,
      "-f",
      `head_sha=${record.headRefOid}`,
      "-f",
      `base_sha=${record.baseRefOid}`,
    ];
  }
  return [
    "workflow",
    "run",
    "ci.yml",
    "--ref",
    record.headRefName,
    "-f",
    `target_ref=${record.headRefOid}`,
    "-f",
    "release_gate=true",
    "-f",
    `pull_request_number=${record.pr}`,
  ];
}

function listCiRuns(headRefOid, backend) {
  const args =
    backend.name === "crabbox"
      ? [
          "api",
          "--method",
          "GET",
          `repos/${REPOSITORY}/actions/workflows/pr-crabbox-gate-publisher.yml/runs`,
          "-f",
          "event=workflow_dispatch",
          "-f",
          "branch=main",
          "-f",
          "per_page=20",
        ]
      : workflowRunsApiArgs(REPOSITORY, headRefOid, "workflow_dispatch", 20);
  return execPrGhJson(args, { stdio: ["ignore", "pipe", "pipe"] }).workflow_runs;
}

function readCurrentPrHeadOid(pr) {
  return execPrGh(["api", `repos/${REPOSITORY}/pulls/${pr}`, "--jq", ".head.sha"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readWorkflowRun(runId) {
  return execPrGhJson(["api", "--method", "GET", `repos/${REPOSITORY}/actions/runs/${runId}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readExactHeadChecks(headSha) {
  const endpoint = `repos/${REPOSITORY}/commits/${headSha}/check-runs?filter=latest&per_page=100`;
  const pages = execPrGhJson(["api", "--paginate", "--slurp", endpoint], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page?.check_runs))) {
    throw new Error("Exact-head check-run pages are malformed.");
  }
  return pages.flatMap(({ check_runs }) => check_runs);
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function requireUnchangedHead(record, phase, readHeadOid) {
  const current = readHeadOid(record.pr);
  if (current !== record.headRefOid) {
    throw new Error(
      `PR #${record.pr} head changed ${phase} (expected ${record.headRefOid}, got ${current}).`,
    );
  }
}

async function waitForCrabboxResult(
  record,
  observedRun,
  {
    readChecks = readExactHeadChecks,
    readRun = readWorkflowRun,
    readHeadOid = readCurrentPrHeadOid,
    terminalPollAttempts = 1080,
    terminalPollIntervalMs = 15_000,
    wait = delay,
  },
) {
  let run;
  for (let attempt = 1; attempt <= terminalPollAttempts; attempt += 1) {
    run = requireCrabboxRun(record, readRun(observedRun.id), observedRun);
    if (run.status === "completed") {
      break;
    }
    if (attempt < terminalPollAttempts) {
      await wait(terminalPollIntervalMs);
    }
  }
  if (run?.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `Protected-main Crabbox publisher did not complete successfully (${run?.status ?? "missing"}/${run?.conclusion ?? "missing"}).`,
    );
  }
  requireUnchangedHead(record, "before exact-head check observation", readHeadOid);
  const check = readChecks(record.headRefOid)
    .filter(
      (candidate) =>
        candidate.name === CRABBOX_CHECK &&
        candidate.head_sha === record.headRefOid &&
        candidate.status === "completed" &&
        candidate.conclusion === "success" &&
        candidate.app?.id === CRABBOX_CHECK_APP_ID &&
        candidate.details_url === run.html_url,
    )
    .toSorted((a, b) => b.id - a.id)[0];
  if (!check) {
    throw new Error("Protected publisher succeeded without the exact-head GitHub Actions check.");
  }
  const binding = parseCrabboxGateCheckSummary(check.output?.summary);
  if (
    binding.baseSha !== record.baseRefOid ||
    binding.headSha !== record.headRefOid ||
    binding.workflowSha !== run.head_sha
  ) {
    throw new Error(
      "Crabbox check summary does not bind the dispatched PR base, head, and workflow.",
    );
  }
  // A rerun keeps the URL, so the check alone cannot pin the completed attempt.
  const finalRun = requireCrabboxRun(record, readRun(run.id), observedRun);
  if (finalRun.status !== "completed" || finalRun.conclusion !== "success") {
    throw new Error("Protected publisher changed after exact-head check observation.");
  }
  requireUnchangedHead(record, "before returning Crabbox proof", readHeadOid);
  return {
    actionsRunId: run.id,
    actionsRunAttempt: run.run_attempt,
    actionsRunUrl: run.html_url,
    backend: "crabbox",
    checkId: check.id,
    provider: "aws",
    target: "linux",
    ...binding,
  };
}

async function dispatchCiForPr(
  record,
  backend,
  {
    listRuns = listCiRuns,
    pollAttempts = 10,
    pollIntervalMs = 1500,
    readHeadOid = readCurrentPrHeadOid,
    runDispatch = (args) =>
      execPrGh(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }, "plain"),
    wait = delay,
    waitForCrabbox = waitForCrabboxResult,
  } = {},
) {
  requirePrRecord(record);
  const pending = backend.pendingGates
    ? pendingGateReceipt(record, backend.resumeRunId !== undefined)
    : undefined;
  if (backend.resumeRunId !== undefined) {
    if (pending.selected && pending.selected.id !== backend.resumeRunId) {
      throw new Error("Resume run does not match the selected pending publisher.");
    }
    requireUnchangedHead(record, "before publisher resume", readHeadOid);
    const selected = pending.selected ?? { id: backend.resumeRunId };
    const run = requireCrabboxRun(record, readWorkflowRun(backend.resumeRunId), selected);
    pending.write(run);
    return waitForCrabbox(record, run, { readHeadOid, wait });
  }
  if (pending?.state) {
    throw new Error(
      "Crabbox dispatch is already pending; inspect its run and use prepare-push --resume-crabbox-run. No new proof dispatched.",
    );
  }
  const priorRunIds = new Set(listRuns(record.headRefOid, backend).map((run) => run.id));
  requireUnchangedHead(record, "before CI dispatch", readHeadOid);
  pending?.write();
  runDispatch(buildCiDispatchArgs(record, backend));

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const run = listRuns(record.headRefOid, backend).find((candidate) => {
      const identityMatches =
        backend.name === "crabbox"
          ? candidate.head_branch === "main" &&
            candidate.display_title === `PR Crabbox gate #${record.pr} / ${record.headRefOid}`
          : candidate.head_sha === record.headRefOid;
      return (
        identityMatches &&
        !priorRunIds.has(candidate.id) &&
        typeof candidate.html_url === "string" &&
        candidate.html_url.length > 0
      );
    });
    if (run) {
      requireUnchangedHead(record, "before an exact-SHA CI run became visible", readHeadOid);
      if (backend.name !== "crabbox") {
        return run;
      }
      const selected = requireCrabboxRun(record, readWorkflowRun(run.id), run);
      pending?.write(selected);
      return waitForCrabbox(record, selected, { readHeadOid, wait });
    }
    if (attempt < pollAttempts) {
      await wait(pollIntervalMs);
    }
  }
  requireUnchangedHead(record, "while CI dispatch was being indexed", readHeadOid);
  if (pending) {
    throw new Error(
      "Crabbox dispatch was accepted but its run is unknown; retain pending gates and select the exact run explicitly. No automatic redispatch.",
    );
  }
  return undefined;
}

function parseBackendArgs(argv) {
  if (argv.length === 0) {
    return { name: "ci" };
  }
  if (argv.length === 2 && argv[0] === "--backend" && argv[1] === "crabbox") {
    return { name: "crabbox" };
  }
  // Internal preparation owns the fixed gates.env receipt; public ci-dispatch
  // keeps its existing dispatch-only surface.
  if (argv[0] === "--backend" && argv[1] === "crabbox" && argv[2] === "--pending-gates") {
    if (argv.length === 3) {
      return { name: "crabbox", pendingGates: true };
    }
    if (argv.length === 5 && argv[3] === "--resume-crabbox-run") {
      return { name: "crabbox", pendingGates: true, resumeRunId: positiveInteger(argv[4]) };
    }
  }
  throw new Error("Expected --backend crabbox, with native preparation options only.");
}

function warnOnLocalHeadDrift(record) {
  const probe = spawnSync(
    process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${record.headRefName}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (probe.status !== 0) {
    return;
  }
  const localOid = probe.stdout.trim();
  if (SHA_PATTERN.test(localOid) && localOid !== record.headRefOid) {
    console.error(
      `warning: local branch ${record.headRefName} is at ${localOid}, but CI is being dispatched for the remote head ${record.headRefOid}; push first if you meant to test local changes.`,
    );
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--read-crabbox-gates") {
    console.log(JSON.stringify(Object.fromEntries(readCrabboxGateReceipt().values)));
    return;
  }
  if (argv.length < 5 || !["true", "false"].includes(argv[4])) {
    console.error(
      "Usage: ci-dispatch.mjs <PR> <headRefName> <headRefOid> <baseRefOid> <isCrossRepository> [--backend crabbox]",
    );
    process.exitCode = 2;
    return;
  }
  const record = {
    baseRefOid: argv[3],
    pr: Number(argv[0]),
    headRefName: argv[1],
    headRefOid: argv[2],
    isCrossRepository: argv[4] === "true",
  };
  const backend = parseBackendArgs(argv.slice(5));
  requirePrRecord(record);
  if (backend.resumeRunId === undefined) {
    warnOnLocalHeadDrift(record);
  }
  const result = await dispatchCiForPr(record, backend);
  if (result) {
    console.log(
      `GitHub verified ${backend.name} workflow for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
    );
    console.log(
      backend.name === "crabbox" ? JSON.stringify(result) : `observed_run_url=${result.html_url}`,
    );
    return;
  }
  console.log(
    `Requested ${backend.name} CI for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
  );
  console.log("run_url=pending (GitHub accepted the dispatch, but Actions has not indexed it yet)");
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[pr-ci-dispatch] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
