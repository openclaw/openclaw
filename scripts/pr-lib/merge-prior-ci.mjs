import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { parseGithubResponse } from "./gh-api-preflight.mjs";
import { execPrGh, execPrGhJson } from "./github.mjs";
import { readMergePolicy, readRequiredMergeChecks } from "./merge-rest.mjs";

const oid = /^[0-9a-f]{40}$/;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function requireEvidence(condition, message) {
  if (!condition) {
    throw new Error(`Prior-CI admin admission: ${message}`);
  }
}

function priorCiDelta(priorHead, head) {
  requireEvidence(oid.test(priorHead) && oid.test(head), "full commit IDs are required");
  const git = (args) =>
    execFileSync(process.env.OPENCLAW_PR_GIT || "git", args, {
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      maxBuffer: 32 * 1024 * 1024,
    });
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

function readEvidence(path, repository, pr, head) {
  requireEvidence(
    lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    "evidence must be a regular file",
  );
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes);
  requireEvidence(
    value.version === 1 &&
      value.changeKind === "conflict-resolution" &&
      value.repository === repository &&
      value.pr === pr &&
      value.head === head,
    "evidence must attest conflict-resolution changes and bind this repository, PR, and prepared head",
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
  const delta = priorCiDelta(value.priorHead, head);
  requireEvidence(
    value.deltaSha256 === delta.deltaSha256,
    "prior-to-prepared delta changed; inspect and validate it again",
  );
  return { ...value, ...delta, evidenceSha256: digest(bytes) };
}

function verifyPriorCiAdmin({ evidencePath, repository, pr, head, actor }) {
  const evidence = readEvidence(evidencePath, repository, pr, head);
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
    execPrGhJson(apiArgs(endpoint, paginate), {}, "plain");
  const writerRead = (endpoint) => {
    const response = parseGithubResponse(
      execPrGh([...apiArgs(endpoint), "--include"], { encoding: "utf8" }, "plain"),
    );
    requireEvidence(response.status === "200", "writer authority is unavailable");
    return response.body;
  };
  const authority = writerRead(`repos/${repository}`);
  requireEvidence(
    authority?.full_name === repository &&
      authority.permissions?.admin === true &&
      authority.owner?.type === "Organization",
    "writer must administer the target organization repository",
  );
  const membership = writerRead(
    `orgs/${repository.split("/")[0]}/memberships/${encodeURIComponent(actor)}`,
  );
  requireEvidence(
    membership?.state === "active" &&
      membership.role === "admin" &&
      membership.user?.login === actor,
    "writer must be an active organization admin",
  );
  const policy = readMergePolicy(repo);
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
    requireReviews ||=
      parameters.required_approving_review_count > 0 ||
      parameters.require_code_owner_review ||
      parameters.require_last_push_approval;
    requireThreads ||= parameters.required_review_thread_resolution;
  }
  const query =
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewDecision reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}}}}";
  const reviewResponse = parseGithubResponse(
    execPrGh(
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
        "-f",
        `query=${query}`,
      ],
      { encoding: "utf8" },
      "plain",
    ),
  );
  const review = reviewResponse.body?.data?.repository?.pullRequest;
  requireEvidence(
    reviewResponse.status === "200" &&
      !reviewResponse.body.errors &&
      review?.headRefOid === head &&
      (review.reviewDecision === "APPROVED" || (!requireReviews && review.reviewDecision === null)),
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
  const run = read(
    `repos/${repository}/actions/runs/${evidence.runId}/attempts/${evidence.runAttempt}`,
  );
  let samePullRequest =
    Array.isArray(run?.pull_requests) &&
    run.pull_requests.some(
      (pull) =>
        pull.number === pr &&
        pull.head?.sha === evidence.priorHead &&
        pull.base?.repo?.id === authority.id,
    );
  if (run?.event === "workflow_dispatch") {
    const pull = writerRead(`repos/${repository}/pulls/${pr}`);
    let ancestor = false;
    try {
      execFileSync(
        process.env.OPENCLAW_PR_GIT || "git",
        ["merge-base", "--is-ancestor", evidence.priorHead, head],
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
  }
  requireEvidence(
    run?.id === evidence.runId &&
      run.run_attempt === evidence.runAttempt &&
      run.head_sha === evidence.priorHead &&
      run.repository?.full_name === repository &&
      /^\.github\/workflows\/ci\.yml(?:@.+)?$/u.test(run.path ?? "") &&
      ["pull_request", "workflow_dispatch"].includes(run.event) &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      samePullRequest,
    "selected successful CI attempt must belong to this PR and prior head",
  );
  const pages = read(
    `repos/${repository}/actions/runs/${evidence.runId}/attempts/${evidence.runAttempt}/jobs?per_page=100`,
    true,
  );
  requireEvidence(
    Array.isArray(pages) &&
      pages.length > 0 &&
      pages.every((page) => Array.isArray(page.jobs)) &&
      pages.flatMap((page) => page.jobs).length === pages[0].total_count &&
      pages.every((page) => page.total_count === pages[0].total_count),
    "prior CI job evidence is incomplete",
  );
  const gate = pages.flatMap((page) => page.jobs).filter((job) => job.name === "openclaw/ci-gate");
  requireEvidence(
    gate.length === 1 &&
      gate[0].status === "completed" &&
      gate[0].conclusion === "success" &&
      gate[0].head_sha === evidence.priorHead &&
      gate[0].run_id === evidence.runId,
    "selected prior attempt must contain a successful CI gate for its exact head",
  );
  const checks = readRequiredMergeChecks(repo, head, policy);
  requireEvidence(
    Array.isArray(checks) &&
      checks.some((check) => check.name === "openclaw/ci-gate") &&
      checks.every(
        (check) =>
          check.bucket === "pass" ||
          (check.name === "openclaw/ci-gate" && ["pending", "skipping"].includes(check.bucket)),
      ),
    "only pending/skipped normal CI may be waived; failed CI and other checks, including security, remain blocking",
  );
  requireEvidence(
    digest(readFileSync(evidencePath)) === evidence.evidenceSha256,
    "operator evidence changed while reading authority",
  );
  return {
    ...evidence,
    actor,
    dispatchTransport: "rest",
    ciUrl: `${repo.url}/actions/runs/${evidence.runId}/attempts/${evidence.runAttempt}`,
    policySha256: digest(JSON.stringify(policy)),
  };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const result =
      mode === "delta"
        ? priorCiDelta(...args)
        : mode === "verify"
          ? verifyPriorCiAdmin({
              evidencePath: args[0],
              repository: args[1],
              pr: Number(args[2]),
              head: args[3],
              actor: args[4],
            })
          : (() => {
              throw new Error(
                "Expected delta <prior-head> <head> or verify <evidence> <repo> <PR> <head> <actor>",
              );
            })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
