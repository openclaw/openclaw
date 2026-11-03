import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { runBelongsToPullRequest } from "../verify-pr-hosted-gates.mts";
import { parseGithubResponse } from "./gh-api-preflight.mjs";
import { execPrGhAsync, execPrGhJsonAsync } from "./github.mjs";
import {
  qualifyPriorCiCancelledRoots,
  verifyPriorCiCancellation,
} from "./merge-prior-ci-cancellation.mjs";
import {
  verifyPriorCiSecurity,
  verifyPriorCiSecurityMainSources,
} from "./merge-prior-ci-security.mjs";
import {
  parseMergeRepository,
  readMergePolicyAsync,
  readRequiredMergeChecksAsync,
  withPriorCiObservation,
} from "./merge-rest.mjs";

const oid = /^[0-9a-f]{40}$/;
const attemptId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mergeCapture = /^merge-output(?:\..+)?\.log$/u;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const blobOid = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const preExisting = (value) => value.changeKind === "pre-existing-failure";
// Only the optional built-artifact workflow has this separate-primary contract.
// Other secondary workflows, especially security publishers, are not CI exceptions.
const secondaryWorkflow = ".github/workflows/ci-build-artifacts-testbox.yml";
const secondaryFailure = (value) => value.primaryCi !== undefined;
const git = (args) =>
  execFileSync(process.env.OPENCLAW_PR_GIT || "git", args, {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
function requireEvidence(condition, message) {
  if (!condition) {
    throw new Error(`Prior-CI admin admission: ${message}`);
  }
}

function isUnacceptedPriorCiRestSquash(record) {
  return (
    record?.version === 1 &&
    record.phase === "intent" &&
    record.accepted === false &&
    record.landed === null &&
    record.route === "admin" &&
    record.method === "squash" &&
    oid.test(record.head ?? "") &&
    attemptId.test(record.attempt ?? "") &&
    positiveInteger(record.pr) &&
    nonempty(record.repo?.nameWithOwner) &&
    record.repo.url === `https://github.com/${record.repo.nameWithOwner}` &&
    record.priorCiAdmin?.version === 1 &&
    record.priorCiAdmin.dispatchTransport === "rest" &&
    record.priorCiAdmin.head === record.head &&
    record.priorCiAdmin.pr === record.pr &&
    record.priorCiAdmin.repository === record.repo.nameWithOwner
  );
}

function readCaptures(source, label) {
  const retained = /^git:([0-9a-f]{40})$/.exec(source ?? "")?.[1];
  requireEvidence(
    source === ".local" || retained,
    `${label} source must be .local or a Git commit`,
  );
  if (retained) {
    requireEvidence(
      git(["cat-file", "-t", retained]).toString("utf8").trim() === "commit",
      `${label} source must be a retained commit`,
    );
    return git(["ls-tree", "-z", retained])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+) (\S+) ([0-9a-f]{40})\t(.*)$/su.exec(line);
        requireEvidence(match, `invalid retained ${label} tree entry`);
        return { name: match[4], mode: match[1], type: match[2], oid: match[3] };
      })
      .filter((entry) => mergeCapture.test(entry.name))
      .map((entry) => {
        requireEvidence(
          entry.mode === "100644" && entry.type === "blob",
          `retained ${label} captures must be regular root blobs`,
        );
        const bytes = git(["cat-file", "blob", entry.oid]);
        requireEvidence(
          blobOid(bytes) === entry.oid,
          `retained ${label} capture does not match its bytes`,
        );
        return { name: entry.name, bytes, oid: entry.oid };
      });
  }
  const stat = lstatSync(source);
  requireEvidence(
    stat.isDirectory() && !stat.isSymbolicLink(),
    `${label} directory must not be a symlink`,
  );
  return readdirSync(source)
    .filter((name) => mergeCapture.test(name))
    .map((name) => {
      const path = `${source}/${name}`;
      const file = lstatSync(path);
      requireEvidence(
        file.isFile() && !file.isSymbolicLink(),
        `${label} captures must be regular nonsymlink files`,
      );
      const bytes = readFileSync(path);
      return { name, bytes, oid: blobOid(bytes) };
    });
}

function qualifyCaptureSet(source, label, expected, verify, allowExtra = false) {
  const entries = readCaptures(source, label);
  const actual = entries.map((entry) => entry.name).toSorted();
  requireEvidence(
    allowExtra
      ? expected.every((name) => actual.includes(name))
      : JSON.stringify(actual) === JSON.stringify(expected),
    `${label} requires ${allowExtra ? "all qualified" : "exactly the expected"} captures`,
  );
  const files = {};
  for (const name of expected) {
    const entry = entries.find((value) => value.name === name);
    verify(name, entry.bytes, entry.oid);
    files[name] = entry.oid;
  }
  return files;
}

function qualifyProviderRejection(recordJson, outcome, source) {
  const record = JSON.parse(recordJson);
  requireEvidence(
    oid.test(outcome ?? "") && isUnacceptedPriorCiRestSquash(record),
    "provider rejection requires an unaccepted exact-head prior-CI admin REST squash intent",
  );
  requireEvidence(
    git(["cat-file", "-t", outcome]).toString("utf8").trim() === "commit" &&
      JSON.stringify(JSON.parse(git(["show", `${outcome}:outcome.json`]))) ===
        JSON.stringify(record),
    "provider rejection must consume the exact retained outcome",
  );
  const capture = `merge-output.${record.attempt}.log`;
  // The retained intent also owns earlier cancelled-auto captures. Their bytes
  // remain evidence of those attempts, not provider rejection for this request.
  const priorCaptures = readCaptures(`git:${outcome}`, "provider rejection");
  requireEvidence(
    !priorCaptures.some((entry) => entry.name === capture),
    "provider rejection must name a new attempt capture",
  );
  const expected = [capture, ...priorCaptures.map((entry) => entry.name)].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  // The request reached GitHub. This exact response qualifies provider rejection,
  // never a claim that dispatch did not happen or permission for an automatic retry.
  const response = Buffer.from(
    '{"message":"Base branch was modified. Review and try the merge again.","documentation_url":"https://docs.github.com/rest/pulls/pulls#merge-a-pull-request","status":"405"}gh: Base branch was modified. Review and try the merge again. (HTTP 405)\n',
  );
  const files = qualifyCaptureSet(
    source,
    "provider rejection",
    expected,
    (name, bytes, blob) => {
      requireEvidence(
        name !== capture || bytes.equals(response),
        "require the complete exact GitHub base-modified HTTP 405 rejection",
      );
      const prior = priorCaptures.find((entry) => entry.name === name);
      requireEvidence(!prior || prior.oid === blob, "inherited provider-rejection capture changed");
    },
    source !== ".local",
  );
  return { kind: "github-base-modified-405", capture, files };
}

function qualifyStaleHeadRetirement(recordJson, outcome, replacementHead, source) {
  const record = JSON.parse(recordJson);
  requireEvidence(
    oid.test(outcome ?? "") &&
      oid.test(replacementHead ?? "") &&
      isUnacceptedPriorCiRestSquash(record) &&
      record.base === "main" &&
      replacementHead !== record.head &&
      nonempty(record.prId),
    "stale-head retirement requires an unaccepted prior-CI admin REST squash intent and an explicit different head",
  );
  requireEvidence(
    git(["cat-file", "-t", outcome]).toString("utf8").trim() === "commit" &&
      JSON.stringify(JSON.parse(git(["show", `${outcome}:outcome.json`]))) ===
        JSON.stringify(record),
    "stale-head retirement must consume the exact retained outcome",
  );

  const currentCapture = `merge-output.${record.attempt}.log`;
  const priorCaptures = readCaptures(`git:${outcome}`, "stale-head retirement");
  requireEvidence(
    !priorCaptures.some((entry) => entry.name === currentCapture),
    "stale-head retirement current attempt capture already exists in the retained intent",
  );
  const expected = [currentCapture, ...priorCaptures.map((entry) => entry.name)].toSorted(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  );
  const files = qualifyCaptureSet(
    source,
    "stale-head retirement",
    expected,
    (name, _bytes, blob) => {
      const prior = priorCaptures.find((value) => value.name === name);
      requireEvidence(!prior || prior.oid === blob, "inherited stale-head capture changed");
    },
    source !== ".local",
  );
  return { kind: "github-rest-sha-head-fenced", capture: currentCapture, files };
}

function priorCiDelta(priorHead, head) {
  requireEvidence(oid.test(priorHead) && oid.test(head), "full commit IDs are required");
  for (const commit of [priorHead, head]) {
    git(["cat-file", "-e", `${commit}^{commit}`]);
  }
  const delta = git(["diff", "--raw", "--abbrev=40", "--no-renames", "-z", priorHead, head, "--"]);
  const changedPaths = git(["diff", "--name-only", "--no-renames", "-z", priorHead, head, "--"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return { priorHead, head, deltaSha256: digest(delta), changedPaths };
}

function readEvidence(path, repository, pr, head, immutable) {
  requireEvidence(
    lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    "evidence must be a regular file",
  );
  const bytes = readFileSync(path);
  const evidenceSha256 = digest(bytes);
  if (immutable?.evidence) {
    const retained = immutable.evidence;
    requireEvidence(
      retained.evidenceSha256 === evidenceSha256 &&
        retained.repository === repository &&
        retained.pr === pr &&
        retained.head === head,
      "immutable proof does not match this evidence and head",
    );
    return retained;
  }
  const value = JSON.parse(bytes);
  requireEvidence(
    value.version === 1 &&
      ["conflict-resolution", "pre-existing-failure"].includes(value.changeKind) &&
      value.repository === repository &&
      value.pr === pr &&
      value.head === head,
    "evidence must name a supported CI exception and bind this repository, PR, and prepared head",
  );
  requireEvidence(
    oid.test(value.priorHead) && positiveInteger(value.runId) && positiveInteger(value.runAttempt),
    "evidence must pin a prior CI head, run, and attempt",
  );
  requireEvidence(
    nonempty(value.reason) &&
      Array.isArray(value.contracts) &&
      value.contracts.length > 0 &&
      value.contracts.every(nonempty),
    "operator reason and affected contracts are required",
  );
  requireEvidence(
    Array.isArray(value.checks) &&
      value.checks.length > 0 &&
      value.checks.every(
        (check) =>
          check && nonempty(check.command) && check.result === "passed" && nonempty(check.evidence),
      ),
    "scoped passing commands and their evidence are required; these remain operator attestations",
  );
  if (secondaryFailure(value)) {
    requireEvidence(
      preExisting(value) &&
        positiveInteger(value.primaryCi?.runId) &&
        positiveInteger(value.primaryCi?.runAttempt) &&
        value.primaryCi.runId !== value.runId,
      "artifact-build failure requires a separate exact primary CI run and attempt",
    );
  }
  const delta = priorCiDelta(value.priorHead, head);
  requireEvidence(
    value.deltaSha256 === delta.deltaSha256,
    "prior-to-prepared delta changed; inspect and validate it again",
  );
  return { ...value, ...delta, evidenceSha256 };
}

function verifyFailureArtifacts(evidence) {
  requireEvidence(
    Array.isArray(evidence.artifacts) &&
      evidence.artifacts.length > 0 &&
      new Set(evidence.artifacts.map((artifact) => artifact?.name)).size ===
        evidence.artifacts.length,
    "pre-existing failures require distinct retained evidence artifacts",
  );
  for (const artifact of evidence.artifacts) {
    requireEvidence(
      nonempty(artifact?.name) &&
        nonempty(artifact.path) &&
        /^[0-9a-f]{64}$/.test(artifact.sha256 ?? ""),
      "each retained artifact requires a name, path, and SHA-256",
    );
    const stat = lstatSync(artifact.path);
    requireEvidence(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        digest(readFileSync(artifact.path)) === artifact.sha256,
      "retained failure evidence changed",
    );
  }
}

function verifyUnchangedEvidence(path, expected) {
  const stat = lstatSync(path);
  const bytes = readFileSync(path);
  requireEvidence(
    stat.isFile() && !stat.isSymbolicLink() && digest(bytes) === expected,
    "operator evidence changed before dispatch",
  );
  const evidence = JSON.parse(bytes);
  if (preExisting(evidence)) {
    verifyFailureArtifacts(evidence);
  }
  return { evidenceSha256: expected };
}

function qualifyPreExistingFailure(evidence, run, jobs, cancelledRoots) {
  verifyFailureArtifacts(evidence);
  const references = (entry) =>
    nonempty(entry?.reason) &&
    Array.isArray(entry.evidence) &&
    entry.evidence.length > 0 &&
    entry.evidence.every((name) => evidence.artifacts.some((artifact) => artifact.name === name));
  requireEvidence(
    oid.test(evidence.testedMerge ?? "") && references(evidence.checkout),
    "the tested merge, protected main, and inspected checkout evidence are required",
  );
  const parents = git(["rev-list", "--parents", "-n", "1", evidence.testedMerge])
    .toString("utf8")
    .trim()
    .split(" ");
  requireEvidence(
    parents.length === 3 && parents[1] === evidence.priorHead && parents[2] === evidence.head,
    "tested merge must have the recorded baseline and exact prepared head as its ordered parents",
  );
  const testedTree = git(["rev-parse", `${evidence.testedMerge}^{tree}`])
    .toString("utf8")
    .trim();
  const derivedTree = git(["merge-tree", "--write-tree", evidence.priorHead, evidence.head])
    .toString("utf8")
    .trim();
  requireEvidence(
    oid.test(derivedTree) && testedTree === derivedTree,
    "tested merge tree must match the recorded baseline and exact prepared head",
  );
  requireEvidence(
    jobs.length > 0 &&
      new Set(jobs.map((job) => job.id)).size === jobs.length &&
      jobs.every(
        (job) =>
          positiveInteger(job.id) &&
          job.run_id === run.id &&
          job.head_sha === evidence.head &&
          job.status === "completed" &&
          ["success", "skipped", "failure", "timed_out", "cancelled"].includes(job.conclusion),
      ),
    "all current-attempt jobs must have complete, matching terminal identities",
  );
  const gate = jobs.find((job) => job.name === "openclaw/ci-gate");
  requireEvidence(
    secondaryFailure(evidence) ? !gate : gate,
    "selected failed attempt has an invalid CI gate",
  );
  const security = jobs.filter((job) => job.name === "security-fast");
  requireEvidence(
    secondaryFailure(evidence) || (security.length === 1 && security[0].conclusion === "success"),
    "security-fast must pass independently",
  );
  const failed = jobs.filter(
    (job) =>
      job !== gate &&
      (["failure", "timed_out"].includes(job.conclusion) || cancelledRoots.has(job.id)),
  );
  const attributions = evidence.failures;
  requireEvidence(
    Array.isArray(attributions) &&
      attributions.length > 0 &&
      attributions.length === failed.length &&
      new Set(attributions.map((entry) => entry?.jobId)).size === failed.length &&
      failed.every((job) => attributions.some((entry) => entry.jobId === job.id)),
    "every failed job must have exactly one independent pre-existing attribution",
  );
  const sourcePaths = [...new Set(attributions.flatMap((entry) => entry.sourcePaths ?? []))];
  requireEvidence(
    sourcePaths.every(
      (path) =>
        nonempty(path) &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        path.split("/").every((part) => part && part !== "." && part !== ".."),
    ),
    "failure source paths must be repository-relative",
  );
  const revisions = sourcePaths.flatMap((path) => [
    `${evidence.priorHead}:${path}`,
    `${evidence.testedMerge}:${path}`,
  ]);
  // rev-parse accepts several revisions without --verify; each output must be an OID.
  const resolved = git(["rev-parse", ...revisions])
    .toString("utf8")
    .trim()
    .split("\n");
  requireEvidence(
    resolved.length === revisions.length && resolved.every((value) => oid.test(value)),
    "failed input objects are unavailable",
  );
  const sourceObjectsByPath = new Map(
    sourcePaths.map((path, index) => {
      requireEvidence(
        resolved[index * 2] === resolved[index * 2 + 1],
        `failed input changed in the tested PR merge: ${path}`,
      );
      return [path, { path, oid: resolved[index * 2] }];
    }),
  );
  const failures = attributions.map((entry) => {
    requireEvidence(
      references(entry) &&
        Array.isArray(entry.cases) &&
        entry.cases.length > 0 &&
        entry.cases.every(nonempty) &&
        Array.isArray(entry.sourcePaths) &&
        entry.sourcePaths.length > 0 &&
        new Set(entry.sourcePaths).size === entry.sourcePaths.length,
      "each failure requires observed cases, inspected independent qualification, and source inputs",
    );
    const sourceObjects = entry.sourcePaths.map((path) => sourceObjectsByPath.get(path));
    return {
      jobId: entry.jobId,
      reason: entry.reason,
      cases: entry.cases,
      sourcePaths: entry.sourcePaths,
      evidence: entry.evidence,
      sourceObjects,
    };
  });
  if (secondaryFailure(evidence)) {
    requireEvidence(
      run.conclusion === "failure" &&
        jobs.every((job) => job.conclusion !== "cancelled") &&
        evidence.aggregate === undefined &&
        evidence.cancellation === undefined &&
        positiveInteger(run.workflow_id) &&
        positiveInteger(run.check_suite_id) &&
        Number.isFinite(Date.parse(run.created_at)) &&
        failures.every((failure) => failure.sourcePaths.includes(secondaryWorkflow)),
      "artifact-build failure requires unchanged workflow inputs and no cancellation or aggregate exception",
    );
    return {
      failures,
      workflowId: run.workflow_id,
      workflowPath: secondaryWorkflow,
      checkSuiteId: run.check_suite_id,
      runCreatedAt: run.created_at,
    };
  }
  const rootIds = failures.map((entry) => entry.jobId).toSorted((a, b) => a - b);
  const causedByRoots = (entry) =>
    references(entry) &&
    Array.isArray(entry.causedBy) &&
    JSON.stringify(entry.causedBy.toSorted((a, b) => a - b)) === JSON.stringify(rootIds);
  requireEvidence(
    evidence.aggregate?.jobId === gate.id && causedByRoots(evidence.aggregate),
    "the failed CI aggregate needs inspected attribution to the admitted root failures",
  );
  const cancellationProof = verifyPriorCiCancellation({
    evidence,
    run,
    jobs,
    failed,
    gate,
    causedByRoots,
    references,
    git,
    requireEvidence,
  });
  return { failures, ...cancellationProof };
}

async function preparePreExistingFailure(
  evidence,
  run,
  jobs,
  main,
  repositoryId,
  immutable,
  deferMain,
  primary,
) {
  if (!deferMain) {
    git(["merge-base", "--is-ancestor", evidence.priorHead, main]);
  }
  const gates = (primary?.jobs ?? jobs).filter((job) => job.name === "openclaw/ci-gate");
  // Completed job data is fixed, but its check-run and annotations remain mutable.
  const cancelledRoots = secondaryFailure(evidence)
    ? new Map()
    : await qualifyPriorCiCancelledRoots({
        evidence,
        run,
        jobs,
        gate: gates[0],
        git,
        requireEvidence,
      });
  const fixed = (immutable.failure ??= qualifyPreExistingFailure(
    evidence,
    run,
    jobs,
    cancelledRoots,
  ));
  return async (checks, qualifiedMain) => {
    // Distinct workflow events remain independent required checks. Only the
    // attested attempt's suite and job may receive the prior-failure exception.
    const current = checks.filter(
      (check) =>
        check.name === "openclaw/ci-gate" &&
        positiveInteger(check.checkRunId) &&
        check.publisherId === 15368 &&
        check.checkSuiteId === (primary?.run ?? run).check_suite_id &&
        gates[0]?.check_run_url ===
          `https://api.github.com/repos/${evidence.repository}/check-runs/${check.checkRunId}`,
    );
    requireEvidence(
      gates.length === 1 &&
        current.length === 1 &&
        (primary
          ? gates[0].conclusion === "success"
          : ["failure", "cancelled"].includes(gates[0].conclusion)) &&
        (primary ? current[0].bucket === "pass" : ["fail", "cancel"].includes(current[0].bucket)) &&
        current[0].publisherId === 15368 &&
        positiveInteger((primary?.run ?? run).check_suite_id),
      "selected failed attempt must own the currently effective CI gate check-run",
    );
    const combined = checks.filter(
      (check) => check.name === "openclaw/ci-gate" && positiveInteger(check.statusId),
    );
    requireEvidence(combined.length === 1, "current combined CI/security status is required");
    const securityReview = await verifyPriorCiSecurity({
      repository: evidence.repository,
      repositoryId,
      pr: evidence.pr,
      head: evidence.head,
      ciRunId: primary?.run.id ?? evidence.runId,
      ciRunAttempt: primary?.run.run_attempt ?? evidence.runAttempt,
      main: qualifiedMain,
      statusId: combined[0].statusId,
    });
    requireEvidence(
      checks.every(
        (check) =>
          check.bucket === "pass" ||
          (!primary &&
            (check === current[0] ||
              (check === combined[0] && check.statusId === securityReview.combinedStatusId))),
      ),
      "pre-existing CI authority does not waive other required checks, including security",
    );
    return {
      ...fixed,
      failures: fixed.failures.map((failure) =>
        Object.assign({}, failure, {
          deadline: cancelledRoots.get(failure.jobId)?.deadline,
          failedStep: cancelledRoots.get(failure.jobId)?.failedStep,
        }),
      ),
      gateCheckRunId: current[0].checkRunId,
      securityReview,
    };
  };
}

// Task authorization still comes from the confirmed operator invocation. GitHub's
// writer-bound ruleset response proves delegated execution capability, not a
// human approval or permission to waive reviews and security.
export function verifyPriorCiWriterAuthority({
  repository,
  actor,
  changeKind,
  policy,
  writerRead,
}) {
  const authority = writerRead(`repos/${repository}`);
  requireEvidence(
    authority?.full_name === repository &&
      positiveInteger(authority.id) &&
      authority.owner?.type === "Organization" &&
      authority.owner.login === repository.split("/")[0],
    "writer repository authority is unavailable",
  );
  const membership = writerRead(
    `orgs/${repository.split("/")[0]}/memberships/${encodeURIComponent(actor)}`,
  );
  requireEvidence(
    membership?.state === "active" &&
      ["admin", "member"].includes(membership.role) &&
      membership.user?.login === actor,
    "writer must be an active organization member",
  );
  if (
    changeKind !== "pre-existing-failure" ||
    authority.permissions?.push !== true ||
    (authority.permissions?.admin === true && membership.role === "admin")
  ) {
    requireEvidence(
      authority.permissions?.admin === true,
      "writer must administer the target organization repository",
    );
    requireEvidence(membership.role === "admin", "writer must be an active organization admin");
    return { authority };
  }
  const ciRules = policy.rules.filter(
    (rule) =>
      rule.type === "required_status_checks" &&
      rule.parameters?.required_status_checks?.some(
        (check) => check.context === "openclaw/ci-gate",
      ),
  );
  requireEvidence(
    ciRules.length > 0,
    "delegated CI-only ruleset bypass requires an effective CI gate",
  );
  const rulesets = ciRules
    .map((rule) => {
      requireEvidence(
        positiveInteger(rule.ruleset_id) &&
          rule.ruleset_source_type === "Repository" &&
          rule.ruleset_source === repository,
        "delegated CI-only ruleset bypass requires an identified repository ruleset",
      );
      const ruleset = writerRead(`repos/${repository}/rulesets/${rule.ruleset_id}`);
      requireEvidence(
        ruleset?.id === rule.ruleset_id &&
          ruleset.source_type === "Repository" &&
          ruleset.source === repository &&
          ruleset.target === "branch" &&
          ruleset.enforcement === "active" &&
          ["always", "pull_requests_only"].includes(ruleset.current_user_can_bypass) &&
          Array.isArray(ruleset.rules) &&
          ruleset.rules.length === 1 &&
          isDeepStrictEqual(ruleset.rules[0], { type: rule.type, parameters: rule.parameters }) &&
          rule.parameters.required_status_checks.length === 1 &&
          rule.parameters.required_status_checks[0].context === "openclaw/ci-gate" &&
          rule.parameters.required_status_checks[0].integration_id === 15368,
        "writer lacks live CI-only ruleset bypass; mixed, changed, or unavailable rulesets cannot delegate this exception",
      );
      return { id: ruleset.id, mode: ruleset.current_user_can_bypass };
    })
    .toSorted((left, right) => left.id - right.id);
  requireEvidence(
    new Set(rulesets.map((ruleset) => ruleset.id)).size === rulesets.length,
    "delegated CI-only ruleset bypass requires unambiguous effective rules",
  );
  return {
    authority,
    delegation: { kind: "ci-ruleset-bypass", repositoryId: authority.id, actor, rulesets },
  };
}

// Drain every read before reporting the first failure; operation locks must not
// outlive unjoined GitHub children. The shared transport caps the actual fan-out.
async function readAll(reads) {
  const results = await Promise.allSettled(reads);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
  return results.map((result) => result.value);
}

async function readWriterAuthority(repository, actor, evidence, policy, read) {
  const endpoints = [
    `repos/${repository}`,
    `orgs/${repository.split("/")[0]}/memberships/${encodeURIComponent(actor)}`,
  ];
  const values = new Map();
  (await readAll(endpoints.map(read))).forEach((value, index) =>
    values.set(endpoints[index], value),
  );
  const authority = values.get(endpoints[0]);
  const membership = values.get(endpoints[1]);
  if (
    preExisting(evidence) &&
    authority?.permissions?.push === true &&
    !(authority.permissions.admin === true && membership?.role === "admin")
  ) {
    const ids = [
      ...new Set(
        policy.rules
          .filter(
            (rule) =>
              rule.type === "required_status_checks" &&
              rule.parameters?.required_status_checks?.some(
                (check) => check.context === "openclaw/ci-gate",
              ),
          )
          .map((rule) => rule.ruleset_id),
      ),
    ];
    requireEvidence(ids.every(positiveInteger), "delegated CI ruleset identity is unavailable");
    const paths = ids.map((id) => `repos/${repository}/rulesets/${id}`);
    (await readAll(paths.map(read))).forEach((value, index) => values.set(paths[index], value));
  }
  return verifyPriorCiWriterAuthority({
    repository,
    actor,
    changeKind: evidence.changeKind,
    policy,
    writerRead: (endpoint) => {
      requireEvidence(values.has(endpoint), "writer authority snapshot is incomplete");
      return values.get(endpoint);
    },
  });
}

async function verifyPriorCiAdmin({
  evidencePath,
  repository,
  pr,
  head,
  actor,
  main,
  immutable = {},
  sharedSnapshot,
  deferFinalAuthority = false,
}) {
  const evidence = readEvidence(evidencePath, repository, pr, head, immutable);
  immutable.evidence = evidence;
  const observedMain = sharedSnapshot?.main ?? main;
  if (sharedSnapshot) {
    requireEvidence(sharedSnapshot.head === head, "qualified snapshot changed the prepared head");
  }
  const repo = {
    nameWithOwner: repository,
    host: "github.com",
    url: `https://github.com/${repository}`,
  };
  const apiArgs = (endpoint, paginate = false) => [
    "api",
    "--hostname",
    repo.host,
    endpoint,
    "-H",
    "Cache-Control: max-age=0",
    ...(paginate ? ["--paginate", "--slurp"] : []),
  ];
  const read = (endpoint, paginate = false) =>
    execPrGhJsonAsync(apiArgs(endpoint, paginate), {}, "plain");
  const writerRead = async (endpoint) => {
    const response = parseGithubResponse(
      await execPrGhAsync([...apiArgs(endpoint), "--include"], { encoding: "utf8" }, "plain"),
    );
    requireEvidence(response.status === "200", "writer authority is unavailable");
    return response.body;
  };
  const policy = sharedSnapshot?.policy ?? (await readMergePolicyAsync(repo));
  const reviewRules = policy.rules.filter((rule) => rule.type === "pull_request");
  let requireReviews = false;
  let requireThreads = false;
  for (const rule of reviewRules) {
    const parameters = rule.parameters;
    requireEvidence(
      parameters &&
        Number.isSafeInteger(parameters.required_approving_review_count) &&
        parameters.required_approving_review_count >= 0 &&
        typeof parameters.require_code_owner_review === "boolean" &&
        typeof parameters.require_last_push_approval === "boolean" &&
        typeof parameters.required_review_thread_resolution === "boolean",
      "effective review requirements are incomplete",
    );
    // Code-owner review is conditional on changed paths; GitHub's per-PR
    // reviewDecision below owns that applicability, including REVIEW_REQUIRED.
    requireReviews ||=
      parameters.required_approving_review_count > 0 || parameters.require_last_push_approval;
    requireThreads ||= parameters.required_review_thread_resolution;
  }
  const verifyReview = (raw) => {
    const reviewResponse = parseGithubResponse(raw);
    const review = reviewResponse.body?.data?.repository?.pullRequest;
    requireEvidence(
      reviewResponse.status === "200" &&
        !reviewResponse.body.errors &&
        review?.headRefOid === head &&
        (review.reviewDecision === "APPROVED" ||
          (!requireReviews && review.reviewDecision === null)),
      "current enforced reviews must be satisfied; admin CI authority does not waive reviews",
    );
    if (requireThreads) {
      requireEvidence(
        review.reviewThreads?.pageInfo?.hasNextPage === false &&
          Array.isArray(review.reviewThreads.nodes) &&
          review.reviewThreads.nodes.every((thread) => thread.isResolved === true),
        "required review threads must all be resolved (more than 100 threads require ordinary landing)",
      );
    }
    return review;
  };
  const query =
    "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewDecision reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100,after:$cursor){totalCount nodes{__typename ... on CheckRun{databaseId name status conclusion isRequired(pullRequestNumber:$number) checkSuite{databaseId app{databaseId} workflowRun{databaseId event createdAt runAttempt workflow{databaseId}}}} ... on StatusContext{context state isRequired(pullRequestNumber:$number)}} pageInfo{hasNextPage endCursor}}}}}}}}}";
  const readReview = async () => {
    const requirements = new Map();
    const secondaryChecks = [];
    const cursors = new Set();
    let cursor;
    let count = 0;
    let total;
    do {
      const review = verifyReview(
        await execPrGhAsync(
          [
            "api",
            "graphql",
            "--hostname",
            repo.host,
            "--include",
            "-H",
            "Cache-Control: max-age=0",
            "-f",
            `owner=${repository.split("/")[0]}`,
            "-f",
            `name=${repository.split("/")[1]}`,
            "-F",
            `number=${pr}`,
            ...(cursor ? ["-f", `cursor=${cursor}`] : []),
            "-f",
            `query=${query}`,
          ],
          { encoding: "utf8" },
          "plain",
        ),
      );
      const commits = review.commits?.nodes;
      requireEvidence(
        commits?.length === 1 && commits[0]?.commit?.oid === head,
        "per-PR required checks changed the prepared head",
      );
      const rollup = commits[0].commit.statusCheckRollup;
      const page = rollup?.contexts;
      requireEvidence(
        rollup === null ||
          (Array.isArray(page?.nodes) &&
            Number.isSafeInteger(page.totalCount) &&
            page.totalCount >= 0 &&
            typeof page.pageInfo?.hasNextPage === "boolean"),
        "per-PR required check inventory is incomplete",
      );
      const pageTotal = page?.totalCount ?? 0;
      total ??= pageTotal;
      requireEvidence(total === pageTotal, "per-PR required check inventory changed while paging");
      for (const node of page?.nodes ?? []) {
        requireEvidence(
          ["CheckRun", "StatusContext"].includes(node?.__typename) &&
            typeof node.isRequired === "boolean",
          "per-PR required check marker is unavailable",
        );
        if (secondaryFailure(evidence)) {
          secondaryChecks.push(node);
        }
        if (!node.isRequired) {
          continue;
        }
        const requirement =
          node.__typename === "CheckRun"
            ? { context: node.name, integration_id: node.checkSuite?.app?.databaseId }
            : { context: node.context, integration_id: null };
        requireEvidence(
          nonempty(requirement.context) &&
            (node.__typename === "StatusContext" || positiveInteger(requirement.integration_id)),
          "per-PR required check publisher is unavailable",
        );
        requirements.set(JSON.stringify(requirement), requirement);
      }
      count += page?.nodes.length ?? 0;
      if (!page?.pageInfo.hasNextPage) {
        break;
      }
      cursor = page.pageInfo.endCursor;
      requireEvidence(
        nonempty(cursor) && !cursors.has(cursor) && page.nodes.length > 0 && count < total,
        "per-PR required check pagination is incomplete",
      );
      cursors.add(cursor);
    } while (cursor);
    requireEvidence(count === total, "per-PR required check inventory is incomplete");
    if (secondaryFailure(evidence)) {
      const expected = evidence.failures.map((failure) => {
        const job = immutable.jobs.find((candidate) => candidate.id === failure.jobId);
        const id = Number(job?.check_run_url?.match(/\/check-runs\/([1-9][0-9]*)$/u)?.[1]);
        requireEvidence(
          positiveInteger(id) &&
            job.check_run_url === `https://api.github.com/repos/${repository}/check-runs/${id}`,
          "artifact-build failed job must bind its exact check-run",
        );
        return { id, job };
      });
      for (const node of secondaryChecks) {
        const workflowRun = node.checkSuite?.workflowRun;
        if (
          workflowRun?.workflow?.databaseId === immutable.failure.workflowId &&
          workflowRun.event === "pull_request" &&
          workflowRun.databaseId !== evidence.runId
        ) {
          requireEvidence(
            Number.isFinite(Date.parse(workflowRun.createdAt)) &&
              Date.parse(workflowRun.createdAt) < Date.parse(immutable.failure.runCreatedAt),
            "a newer artifact-build workflow run invalidates the selected failure",
          );
        }
        const match = expected.find(({ id }) => id === node.databaseId);
        if (match) {
          requireEvidence(
            node.__typename === "CheckRun" &&
              node.isRequired === false &&
              node.name === match.job.name &&
              node.status === "COMPLETED" &&
              node.conclusion === match.job.conclusion.toUpperCase() &&
              node.checkSuite?.databaseId === immutable.failure.checkSuiteId &&
              node.checkSuite?.app?.databaseId === 15368 &&
              node.checkSuite?.workflowRun?.databaseId === evidence.runId &&
              node.checkSuite.workflowRun.event === "pull_request" &&
              node.checkSuite.workflowRun.runAttempt === evidence.runAttempt &&
              node.checkSuite.workflowRun.workflow?.databaseId === immutable.failure.workflowId,
            "artifact-build failed check must be optional and match the exact job, suite, workflow, and publisher",
          );
        } else {
          requireEvidence(
            node.__typename === "CheckRun"
              ? node.status === "COMPLETED" &&
                  ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(node.conclusion)
              : node.state === "SUCCESS",
            "artifact-build failure admission does not waive other failed or unfinished checks",
          );
        }
      }
      requireEvidence(
        expected.every(
          ({ id }) => secondaryChecks.filter((node) => node.databaseId === id).length === 1,
        ),
        "every artifact-build failure needs one current native optional-check marker",
      );
    }
    const known = policy.rules
      .filter((rule) => rule.type === "required_status_checks")
      .flatMap((rule) => rule.parameters.required_status_checks);
    const additional = [...requirements.values()].filter(
      (check) =>
        !known.some(
          (existing) =>
            existing.context === check.context &&
            (check.integration_id === null || existing.integration_id === check.integration_id),
        ),
    );
    if (additional.length > 0) {
      // Native per-PR markers supply requirement facts, not historical results.
      // The existing REST owner selects latest runs and binds their publishers.
      const checks = await readRequiredMergeChecksAsync(repo, head, {
        rules: [
          { type: "required_status_checks", parameters: { required_status_checks: additional } },
        ],
      });
      requireEvidence(
        checks.every((check) => check.bucket === "pass"),
        "admin CI authority does not waive other required checks, including security",
      );
    }
  };
  const authorityRead = readWriterAuthority(repository, actor, evidence, policy, writerRead);
  const [writer, , run, latest, pages] = await readAll([
    authorityRead,
    deferFinalAuthority || secondaryFailure(evidence) ? null : readReview(),
    read(`repos/${repository}/actions/runs/${evidence.runId}/attempts/${evidence.runAttempt}`),
    preExisting(evidence) ? read(`repos/${repository}/actions/runs/${evidence.runId}`) : null,
    immutable.jobs
      ? [{ jobs: immutable.jobs, total_count: immutable.jobs.length }]
      : read(
          `repos/${repository}/actions/runs/${evidence.runId}/attempts/${evidence.runAttempt}/jobs?per_page=20`,
          true,
        ),
  ]);
  const { authority, delegation } = writer;
  if (sharedSnapshot) {
    requireEvidence(
      sharedSnapshot.repositoryId === authority.id,
      "qualified snapshot changed the repository identity",
    );
  }
  const runHead = preExisting(evidence) ? head : evidence.priorHead;
  let samePullRequest =
    Array.isArray(run?.pull_requests) &&
    run.pull_requests.some(
      (pull) =>
        pull.number === pr && pull.head?.sha === runHead && pull.base?.repo?.id === authority.id,
    );
  let runAssociation = "pull-request";
  if (
    preExisting(evidence) &&
    run?.event === "pull_request" &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.length === 0
  ) {
    const pull = await writerRead(`repos/${repository}/pulls/${pr}`);
    samePullRequest =
      pull?.number === pr &&
      pull.head?.sha === head &&
      pull.base?.ref === "main" &&
      pull.base?.repo?.id === authority.id &&
      positiveInteger(pull.head?.repo?.id) &&
      pull.head.repo.id === run.head_repository?.id &&
      nonempty(pull.head.repo.full_name) &&
      runBelongsToPullRequest(run, pr, new Set([head]), pull.head.ref, pull.head.repo.full_name);
    runAssociation = "exact-source-and-current-check";
  }
  if (run?.event === "workflow_dispatch") {
    const pull = await writerRead(`repos/${repository}/pulls/${pr}`);
    let ancestor = false;
    try {
      execFileSync(
        process.env.OPENCLAW_PR_GIT || "git",
        ["merge-base", "--is-ancestor", runHead, head],
        { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, stdio: "pipe" },
      );
      ancestor = true;
    } catch {
      /* An unretained or rewritten prior head cannot supply ancestry proof. */
    }
    samePullRequest =
      ancestor &&
      pull?.number === pr &&
      pull.head?.sha === head &&
      pull.base?.ref === "main" &&
      pull.base?.repo?.id === authority.id &&
      pull.head?.repo?.id === authority.id &&
      run.head_branch === pull.head?.ref &&
      run.head_repository?.full_name === repository;
    runAssociation = "same-repository-dispatch";
  }
  requireEvidence(
    run?.id === evidence.runId &&
      run.run_attempt === evidence.runAttempt &&
      run.head_sha === runHead &&
      run.repository?.full_name === repository &&
      (secondaryFailure(evidence)
        ? run.path === secondaryWorkflow && run.event === "pull_request"
        : /^\.github\/workflows\/ci\.yml(?:@.+)?$/u.test(run.path ?? "")) &&
      ["pull_request", "workflow_dispatch"].includes(run.event) &&
      run.status === "completed" &&
      (preExisting(evidence)
        ? secondaryFailure(evidence)
          ? run.conclusion === "failure"
          : ["failure", "cancelled"].includes(run.conclusion)
        : run.conclusion === "success") &&
      samePullRequest,
    "selected CI attempt must have the expected conclusion and belong to this PR and tested head",
  );
  if (preExisting(evidence)) {
    requireEvidence(
      latest?.id === run.id &&
        latest.run_attempt === run.run_attempt &&
        latest.head_sha === head &&
        latest.status === run.status &&
        latest.conclusion === run.conclusion,
      "a newer or running CI attempt invalidates pre-existing failure evidence",
    );
  }
  requireEvidence(
    Array.isArray(pages) &&
      pages.length > 0 &&
      pages.every((page) => Array.isArray(page.jobs)) &&
      pages.flatMap((page) => page.jobs).length === pages[0].total_count &&
      pages.every((page) => page.total_count === pages[0].total_count),
    "prior CI job evidence is incomplete",
  );
  const jobs = pages.flatMap((page) => page.jobs);
  immutable.jobs = jobs;
  let primary;
  if (secondaryFailure(evidence)) {
    const prefix = `repos/${repository}/actions/runs/${evidence.primaryCi.runId}`;
    const [selected, latestPrimary, primaryPages] = await readAll([
      read(`${prefix}/attempts/${evidence.primaryCi.runAttempt}`),
      read(prefix),
      read(`${prefix}/attempts/${evidence.primaryCi.runAttempt}/jobs?per_page=20`, true),
    ]);
    requireEvidence(
      selected?.id === evidence.primaryCi.runId &&
        selected.run_attempt === evidence.primaryCi.runAttempt &&
        selected.head_sha === head &&
        selected.repository?.full_name === repository &&
        selected.path === ".github/workflows/ci.yml" &&
        selected.event === "pull_request" &&
        selected.status === "completed" &&
        selected.conclusion === "success" &&
        positiveInteger(selected.head_repository?.id) &&
        selected.head_repository.id === run.head_repository?.id &&
        selected.head_branch === run.head_branch &&
        Array.isArray(selected.pull_requests) &&
        runBelongsToPullRequest(
          selected,
          pr,
          new Set([head]),
          run.head_branch,
          run.head_repository.full_name,
        ) &&
        latestPrimary?.id === selected.id &&
        latestPrimary.run_attempt === selected.run_attempt &&
        latestPrimary.head_sha === head &&
        latestPrimary.status === "completed" &&
        latestPrimary.conclusion === "success" &&
        positiveInteger(selected.workflow_id) &&
        positiveInteger(selected.check_suite_id),
      "artifact-build failure requires the current successful primary CI attempt on the same PR source",
    );
    requireEvidence(
      Array.isArray(primaryPages) &&
        primaryPages.length > 0 &&
        primaryPages.every(
          (page) => Array.isArray(page.jobs) && page.total_count === primaryPages[0].total_count,
        ) &&
        primaryPages.flatMap((page) => page.jobs).length === primaryPages[0].total_count,
      "primary CI job evidence is incomplete",
    );
    const primaryJobs = primaryPages.flatMap((page) => page.jobs);
    requireEvidence(
      new Set(primaryJobs.map((job) => job.id)).size === primaryJobs.length &&
        primaryJobs.every(
          (job) =>
            positiveInteger(job.id) &&
            job.run_id === selected.id &&
            job.head_sha === head &&
            job.status === "completed" &&
            ["success", "skipped"].includes(job.conclusion),
        ) &&
        ["openclaw/ci-gate", "security-fast"].every(
          (name) =>
            primaryJobs.filter((job) => job.name === name).length === 1 &&
            primaryJobs.find((job) => job.name === name).conclusion === "success",
        ),
      "primary CI gate and security-fast must pass with complete terminal coverage",
    );
    primary = { run: selected, jobs: primaryJobs };
  }
  const gate = jobs.filter((job) => job.name === "openclaw/ci-gate");
  if (!preExisting(evidence)) {
    requireEvidence(
      gate.length === 1 &&
        gate[0].status === "completed" &&
        gate[0].conclusion === "success" &&
        gate[0].head_sha === evidence.priorHead &&
        gate[0].run_id === evidence.runId,
      "selected prior attempt must contain a successful CI gate for its exact head",
    );
  }
  const checks = deferFinalAuthority
    ? undefined
    : await readRequiredMergeChecksAsync(repo, head, policy, {
        includeCheckIdentity: preExisting(evidence),
      });
  const finishFailureProof = preExisting(evidence)
    ? await preparePreExistingFailure(
        evidence,
        run,
        jobs,
        observedMain,
        authority.id,
        immutable,
        Boolean(sharedSnapshot),
        primary,
      )
    : undefined;
  const failureProof =
    !deferFinalAuthority && finishFailureProof
      ? await finishFailureProof(checks, observedMain)
      : undefined;
  const verifyChecks = (currentChecks) => {
    requireEvidence(
      Array.isArray(currentChecks) &&
        currentChecks.some((check) => check.name === "openclaw/ci-gate") &&
        currentChecks.every(
          (check) =>
            check.bucket === "pass" ||
            (check.name === "openclaw/ci-gate" && ["pending", "skipping"].includes(check.bucket)),
        ),
      "only pending/skipped normal CI may be waived; failed CI and other checks, including security, remain blocking",
    );
  };
  if (!preExisting(evidence) && !deferFinalAuthority) {
    verifyChecks(checks);
  }
  const complete = async (qualifiedMain = observedMain, currentChecks = checks) => {
    if (!preExisting(evidence) && deferFinalAuthority) {
      verifyChecks(currentChecks);
    }
    // Historical proof precedes the final observation; mutable reviews and
    // security follow it, with writer authority last and no duplicate inventory.
    const [, finalFailureProof] = await readAll([
      deferFinalAuthority || secondaryFailure(evidence) ? readReview() : null,
      deferFinalAuthority && finishFailureProof
        ? finishFailureProof(currentChecks, qualifiedMain)
        : failureProof,
    ]);
    // Security qualification awaits external work. Re-read effective policy
    // afterward so a CI-only grant cannot waive newly tightened requirements.
    const finalPolicy = await readMergePolicyAsync(repo);
    const current = await readWriterAuthority(repository, actor, evidence, finalPolicy, writerRead);
    requireEvidence(
      isDeepStrictEqual(finalPolicy, policy) && isDeepStrictEqual(current.delegation, delegation),
      "writer policy or delegated bypass changed during admission",
    );
    requireEvidence(
      digest(readFileSync(evidencePath)) === evidence.evidenceSha256,
      "operator evidence changed while reading authority",
    );
    return {
      ...evidence,
      ...finalFailureProof,
      ...(preExisting(evidence) ? { runAssociation } : {}),
      delegation,
      actor,
      dispatchTransport: "rest",
      ciUrl: `${repo.url}/actions/runs/${evidence.runId}/attempts/${evidence.runAttempt}`,
      policySha256: digest(JSON.stringify(policy)),
    };
  };
  return deferFinalAuthority ? { complete } : complete();
}

async function verifyMode(mode, options) {
  if (mode === "verify") {
    return verifyPriorCiAdmin(options);
  }
  // This cache is carried only over stdin by the uninterrupted lock-owning
  // shell invocation, never loaded from mutable preparation files or env.
  const input = readFileSync(0, "utf8").trim();
  const immutable = input ? JSON.parse(input) : {};
  if (mode === "verify-cached") {
    const proof = await verifyPriorCiAdmin({ ...options, immutable });
    return { proof, immutable };
  }
  const repo = parseMergeRepository(options.repositoryIdentity);
  requireEvidence(
    repo.nameWithOwner === options.repository,
    "qualified repository identity differs",
  );
  const result = await withPriorCiObservation(repo, options.pr, {
    prepare: (sharedSnapshot) =>
      verifyPriorCiAdmin({ ...options, immutable, sharedSnapshot, deferFinalAuthority: true }),
    finish: (prepared, snapshot) => prepared.complete(snapshot.main, snapshot.checks),
  });
  return {
    proof: result.value,
    observation: result.observation,
    qualifiedMain: result.qualifiedMain,
    immutable,
  };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const result =
      mode === "verify-main-sources"
        ? verifyPriorCiSecurityMainSources(
            JSON.parse(readFileSync(0, "utf8")).securityReview,
            args[0],
          )
        : mode === "delta"
          ? priorCiDelta(...args)
          : mode === "unchanged"
            ? verifyUnchangedEvidence(...args)
            : mode === "provider-rejection"
              ? qualifyProviderRejection(readFileSync(0, "utf8"), ...args)
              : mode === "stale-head-retirement"
                ? qualifyStaleHeadRetirement(readFileSync(0, "utf8"), ...args)
                : mode === "verify" || mode === "verify-cached" || mode === "qualify"
                  ? await verifyMode(mode, {
                      evidencePath: args[0],
                      repository: args[1],
                      pr: Number(args[2]),
                      head: args[3],
                      actor: args[4],
                      main: args[5],
                      repositoryIdentity: args[6],
                    })
                  : (() => {
                      throw new Error(
                        "Expected delta <prior-head> <head>, unchanged <evidence> <sha256>, provider-rejection <outcome> <.local|git:successor> (record JSON on stdin), stale-head-retirement <outcome> <replacement-head> <.local|git:successor> (record JSON on stdin), or verify <evidence> <repo> <PR> <head> <actor> [main]",
                      );
                    })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
