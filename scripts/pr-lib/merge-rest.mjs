import { createHash } from "node:crypto";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { parseGithubResponse } from "./gh-api-preflight.mjs";
import { execPrGh, execPrGhAsync, execPrGhJson } from "./github.mjs";

const OID = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// REST values normalize into GitHub's MergeStateStatus enum, never arbitrary admission states.
// https://docs.github.com/en/graphql/reference/pulls#mergestatestatus
const MERGE_STATES = new Set(
  "behind blocked clean dirty draft has_hooks unknown unstable".split(" "),
);
const RULE_TYPES = new Set([
  "deletion",
  "non_fast_forward",
  "required_linear_history",
  "pull_request",
  "required_status_checks",
]);

function requireEvidence(condition, message) {
  if (!condition) {
    const error = new Error(`REST merge fallback: ${message}.`);
    error.status = 65;
    throw error;
  }
}

function requireRestSupport(condition, message, code = "OPENCLAW_REST_UNSUPPORTED") {
  if (!condition) {
    const error = new Error(`REST merge: ${message}.`);
    error.code = code;
    throw error;
  }
}

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const nonemptyString = (value) => typeof value === "string" && value.length > 0;

function canonical(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonical)
      .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  return value !== null && typeof value === "object"
    ? Object.fromEntries(
        Object.keys(value)
          .toSorted()
          .map((key) => [key, canonical(value[key])]),
      )
    : value;
}

export function parseMergeRepository(value) {
  const repo = JSON.parse(value);
  requireEvidence(
    repo &&
      (positiveInteger(repo.id) || nonemptyString(repo.id)) &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.nameWithOwner ?? "") &&
      /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.url ?? "") &&
      repo.url.endsWith(`/${repo.nameWithOwner}`),
    "invalid repository identity",
  );
  return { ...repo, host: new URL(repo.url).hostname };
}

function apiArgs(repo, endpoint, extra = []) {
  return [
    "api",
    "--hostname",
    repo.host,
    `repos/${repo.nameWithOwner}${endpoint}`,
    "-H",
    "Cache-Control: max-age=0",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
    ...extra,
  ];
}

function read(repo, endpoint, paginate = false) {
  return execPrGhJson(
    apiArgs(repo, endpoint, paginate ? ["--paginate", "--slurp"] : []),
    {},
    "plain",
  );
}

function request(repo, endpoint, paginate = false, raw = false) {
  return {
    args: apiArgs(repo, endpoint, raw ? ["--include"] : paginate ? ["--paginate", "--slurp"] : []),
    raw,
  };
}

function requestResult(result) {
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

function runReadSteps(steps) {
  let step = steps.next();
  while (!step.done) {
    const results = step.value.map(({ args, raw }) => {
      try {
        const value = execPrGh(args, { encoding: "utf8" }, "plain");
        return { status: "fulfilled", value: raw ? value : JSON.parse(value) };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    });
    step = steps.next(results);
  }
  return step.value;
}

async function runReadStepsAsync(steps) {
  let step = steps.next();
  while (!step.done) {
    // Drain every sibling before propagating a refusal or changing authority rounds.
    const results = await Promise.allSettled(
      step.value.map(async ({ args, raw }) => {
        const value = await execPrGhAsync(args, { encoding: "utf8" }, "plain");
        return raw ? value : JSON.parse(value);
      }),
    );
    step = steps.next(results);
  }
  return step.value;
}

function* readSteps(repo, endpoint, paginate = false) {
  const [result] = yield [request(repo, endpoint, paginate)];
  return requestResult(result);
}

function readMain(repo) {
  return mainReference(read(repo, "/git/ref/heads/main"));
}

function mainReference(reference) {
  requireEvidence(
    reference?.ref === "refs/heads/main" &&
      reference.object?.type === "commit" &&
      OID.test(reference.object.sha ?? ""),
    "main is unavailable",
  );
  return reference.object.sha;
}

function pageArrays(pages) {
  requireEvidence(
    Array.isArray(pages) && pages.length > 0 && pages.every(Array.isArray),
    "incomplete paginated policy",
  );
  return pages.flat();
}

function readMergePolicy(repo) {
  return runReadSteps(mergePolicySteps(repo));
}

export function readMergePolicyAsync(repo) {
  return runReadStepsAsync(mergePolicySteps(repo));
}

function* mergePolicySteps(repo) {
  // GitHub enforces classic protection at the pinned merge request. Its
  // admin-only discovery endpoint is not a prerequisite for maintainer landing.
  // Applicable rules still supply required-check and delegated CI evidence.
  const [rulesResult] = yield [request(repo, "/rules/branches/main?per_page=100", true)];
  const rules = pageArrays(requestResult(rulesResult));
  for (const rule of rules) {
    requireEvidence(nonemptyString(rule?.type), "missing effective branch rule");
    requireRestSupport(RULE_TYPES.has(rule.type), "unsupported effective branch rule");
    if (rule.type === "pull_request") {
      const methods = rule.parameters?.allowed_merge_methods;
      requireEvidence(
        methods === undefined || (Array.isArray(methods) && methods.includes("squash")),
        "branch policy does not permit squash merges",
      );
    }
    if (rule.type === "required_status_checks") {
      requireEvidence(
        Array.isArray(rule.parameters?.required_status_checks),
        "missing required-check policy",
      );
      for (const check of rule.parameters.required_status_checks) {
        requireEvidence(
          nonemptyString(check?.context) &&
            (check.integration_id == null || positiveInteger(check.integration_id)),
          "invalid required-check app binding",
        );
      }
    }
  }
  // Preserve retained snapshot/hash shape; null is not an absence attestation.
  return canonical({ classicProtection: null, rules });
}

function readPullRequest(repo, authority, pr) {
  // Mergeability depends on the writer; pooled readers can see a different policy projection.
  const response = parseGithubResponse(
    execPrGh(apiArgs(repo, `/pulls/${pr}`, ["--include"]), { encoding: "utf8" }, "plain"),
  );
  return validatePullRequest(repo, authority, pr, response);
}

function validatePullRequest(repo, authority, pr, response) {
  const record = response.body;
  requireEvidence(
    response.status === "200" &&
      record?.number === pr &&
      nonemptyString(record.node_id) &&
      nonemptyString(record.title) &&
      record.html_url === `${repo.url}/pull/${pr}` &&
      record.base?.repo?.id === authority.id &&
      record.base.repo.node_id === authority.node_id &&
      record.base.repo.full_name === repo.nameWithOwner &&
      record.base.ref === "main" &&
      OID.test(record.base.sha ?? "") &&
      OID.test(record.head?.sha ?? "") &&
      nonemptyString(record.head?.ref) &&
      ["open", "closed"].includes(record.state) &&
      typeof record.merged === "boolean" &&
      typeof record.draft === "boolean" &&
      [true, false, null].includes(record.mergeable) &&
      MERGE_STATES.has(record.mergeable_state) &&
      Object.hasOwn(record, "auto_merge") &&
      (record.auto_merge === null ||
        ["squash", "merge", "rebase"].includes(record.auto_merge?.merge_method)),
    "invalid PR identity or lifecycle evidence",
  );
  requireRestSupport(
    record.state !== "open" || (!record.merged && record.auto_merge === null),
    "open PR already has an auto-merge request or inconsistent lifecycle",
  );
  // API 2026-03-10 omits the landed commit from PR resources. Use the complete
  // GraphQL observation; the async result alone cannot replace the PR receipt.
  requireRestSupport(
    !record.merged || record.state !== "closed" || Object.hasOwn(record, "merge_commit_sha"),
    "merged PR commit requires GraphQL observation",
    "OPENCLAW_REST_MERGED_RECEIPT_UNAVAILABLE",
  );
  requireEvidence(
    !record.merged || (record.state === "closed" && OID.test(record.merge_commit_sha ?? "")),
    "merged PR has no valid merge commit",
  );
  return record;
}

function pullRequest(record) {
  return {
    id: record.node_id,
    number: record.number,
    url: record.html_url,
    state: record.merged ? "MERGED" : record.state.toUpperCase(),
    headRefOid: record.head.sha,
    baseRefName: record.base.ref,
    isDraft: record.draft,
    mergeCommit: record.merged ? { oid: record.merge_commit_sha } : null,
    autoMergeRequest:
      record.auto_merge === null
        ? null
        : { mergeMethod: record.auto_merge.merge_method.toUpperCase() },
    isInMergeQueue: false,
    isMergeQueueEnabled: false,
    mergeable:
      record.mergeable === null ? "UNKNOWN" : record.mergeable ? "MERGEABLE" : "CONFLICTING",
    mergeStateStatus: record.mergeable_state.toUpperCase(),
  };
}

function repositoryAuthority(repo, response) {
  const authority = response.body;
  requireEvidence(
    response.status === "200" &&
      positiveInteger(authority?.id) &&
      nonemptyString(authority.node_id) &&
      (repo.id === authority.id || repo.id === authority.node_id) &&
      authority.full_name === repo.nameWithOwner &&
      authority.html_url === repo.url,
    "repository identity changed",
  );
  return authority;
}

function beginRead(repo, pr, observe) {
  const startedAtMs = Date.now();
  // Included headers select the protected writer route, so pooled-reader
  // permissions cannot establish the actor's repository write access.
  const response = parseGithubResponse(
    execPrGh(apiArgs(repo, "", ["--include"]), { encoding: "utf8" }, "plain"),
  );
  const authority = repositoryAuthority(repo, response);
  const mainSha = readMain(repo);
  const record = readPullRequest(repo, authority, pr);
  // An already-merged receipt proves a historical action. New protection or
  // reduced privileges cannot invalidate the retained head and tree proof.
  const receipt = observe && record.merged;
  requireRestSupport(
    receipt || authority.permissions?.admin === true || authority.permissions?.push === true,
    "repository write access changed",
  );
  const policy = receipt ? null : readMergePolicy(repo);
  return { authority, main: mainSha, record, policy, startedAtMs };
}

function samePullRequestIdentity(current, previous) {
  const identity = (record) => {
    const {
      mergeable: _mergeable,
      mergeStateStatus: _mergeStateStatus,
      ...facts
    } = pullRequest(record);
    return facts;
  };
  return JSON.stringify(identity(current)) === JSON.stringify(identity(previous));
}

function finishRead(repo, pr, snapshot, requireStableMain, priorCiObservation) {
  const current = readPullRequest(repo, snapshot.authority, pr);
  const sameIdentity = samePullRequestIdentity(current, snapshot.record);
  const { requiredChecks: _checks, ...policy } = snapshot.policy ?? {};
  const samePolicy =
    !priorCiObservation ||
    current.merged ||
    JSON.stringify(readMergePolicy(repo)) === JSON.stringify(policy);
  const mainSha = readMain(repo);
  if (priorCiObservation || mainSha !== snapshot.main || !sameIdentity || !samePolicy) {
    const finishedAtMs = Date.now();
    console.error(
      `REST merge observation: ${JSON.stringify({
        transport: "rest",
        requestedGhRoute: "plain",
        observedGhRoute: "unrecorded",
        requestedCacheControl: "max-age=0",
        mainBefore: snapshot.main,
        mainAfter: mainSha,
        startedAtMs: snapshot.startedAtMs,
        finishedAtMs,
        elapsedMs: finishedAtMs - snapshot.startedAtMs,
      })}`,
    );
  }
  requireEvidence(sameIdentity, "PR identity, head, or lifecycle changed while reading evidence");
  requireEvidence(samePolicy, "branch policy changed while reading evidence");
  requireEvidence(
    !requireStableMain || current.merged || mainSha === snapshot.main,
    "main changed while reading evidence",
  );
  snapshot.mainBefore = snapshot.main;
  snapshot.main = mainSha;
  return current;
}

function* checkPagesSteps(repo, endpoint, key, head) {
  return checkPageValues(yield* readSteps(repo, endpoint, true), key, head);
}

function checkPageValues(pages, key, head) {
  requireEvidence(Array.isArray(pages) && pages.length > 0, "missing check pages");
  const count = pages[0]?.total_count;
  requireEvidence(Number.isSafeInteger(count) && count >= 0, "invalid check count");
  const values = [];
  for (const page of pages) {
    requireEvidence(
      page?.total_count === count &&
        Array.isArray(page[key]) &&
        (key !== "statuses" || (page.sha === head && page.state === pages[0].state)),
      "check snapshot changed during pagination",
    );
    values.push(...page[key]);
  }
  requireEvidence(values.length === count, "incomplete check pagination");
  if (key === "statuses") {
    const aggregate = values.some((value) => ["failure", "error"].includes(value.state))
      ? "failure"
      : values.length === 0 || values.some((value) => value.state === "pending")
        ? "pending"
        : "success";
    requireEvidence(pages[0].state === aggregate, "combined status contradicts its contexts");
  }
  return values;
}

function bucket(state) {
  if (state === "SUCCESS") {
    return "pass";
  }
  if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(state)) {
    return "fail";
  }
  if (state === "CANCELLED") {
    return "cancel";
  }
  if (["SKIPPED", "NEUTRAL"].includes(state)) {
    return "skipping";
  }
  return "pending";
}

function validCheckRuns(checks, head) {
  return (
    checks.every(
      (check) =>
        positiveInteger(check?.id) &&
        check.head_sha === head &&
        nonemptyString(check.name) &&
        positiveInteger(check.app?.id) &&
        nonemptyString(check.status) &&
        (check.conclusion === null || nonemptyString(check.conclusion)),
    ) && new Set(checks.map((check) => check.id)).size === checks.length
  );
}

function* latestRequiredChecksSteps(repo, head, checks) {
  const repeated = new Set();
  const names = new Set();
  for (const check of checks) {
    const name = JSON.stringify([check.app.id, check.name]);
    if (names.has(name)) {
      repeated.add(name);
    }
    names.add(name);
  }
  if (repeated.size === 0) {
    return checks;
  }
  const runs = yield* checkPagesSteps(
    repo,
    `/actions/runs?head_sha=${head}&exclude_pull_requests=true&per_page=100`,
    "workflow_runs",
    head,
  );
  requireEvidence(
    runs.length <= 1_000 &&
      new Set(runs.map((run) => run.id)).size === runs.length &&
      runs.every(
        (run) =>
          positiveInteger(run?.id) &&
          run.head_sha === head &&
          positiveInteger(run.check_suite_id) &&
          positiveInteger(run.workflow_id) &&
          nonemptyString(run.event),
      ),
    "incomplete or invalid required-check workflow identities",
  );
  const suites = new Map();
  for (const run of runs) {
    suites.set(run.check_suite_id, suites.has(run.check_suite_id) ? null : run);
  }
  const groups = new Map();
  const unique = [];
  for (const check of checks) {
    if (!repeated.has(JSON.stringify([check.app.id, check.name]))) {
      unique.push(check);
      continue;
    }
    const run = suites.get(check.check_suite?.id);
    const started = Date.parse(check.started_at);
    requireEvidence(
      check.app.slug === "github-actions" && run && Number.isFinite(started),
      "cannot establish repeated required-check workflow or start time",
    );
    const key = JSON.stringify([check.app.id, check.name, run.workflow_id, run.event]);
    const previous = groups.get(key);
    requireEvidence(
      !previous || Date.parse(previous.started_at) !== started,
      "repeated required checks have ambiguous start times",
    );
    if (!previous || Date.parse(previous.started_at) < started) {
      groups.set(key, check);
    }
  }
  return [...unique, ...groups.values()];
}

function readRequiredMergeChecks(repo, head, policy, options = {}) {
  return runReadSteps(requiredMergeChecksSteps(repo, head, policy, options));
}

export function readRequiredMergeChecksAsync(repo, head, policy, options = {}) {
  return runReadStepsAsync(requiredMergeChecksSteps(repo, head, policy, options));
}

function* requiredMergeChecksSteps(repo, head, policy, { includeCheckIdentity = false } = {}) {
  const requirements = new Map();
  for (const rule of policy.rules) {
    if (rule.type !== "required_status_checks") {
      continue;
    }
    for (const check of rule.parameters.required_status_checks) {
      const requirement = { context: check.context, app: check.integration_id ?? null };
      requirements.set(JSON.stringify(requirement), requirement);
    }
  }
  if (requirements.size === 0) {
    return [];
  }
  const required = [...requirements.values()];
  const matchesRequired = (check) =>
    required.some(
      ({ context, app }) => check.name === context && (app === null || check.app.id === app),
    );
  const contexts = new Set(required.map(({ context }) => context));
  const nameFilter =
    contexts.size === 1 ? `&check_name=${encodeURIComponent(required[0].context)}` : "";
  const [checksResult, statusesResult] = yield [
    request(repo, `/commits/${head}/check-runs?filter=latest${nameFilter}&per_page=100`, true),
    request(repo, `/commits/${head}/status?per_page=100`, true),
  ];
  const checks = checkPageValues(requestResult(checksResult), "check_runs", head);
  const statuses = checkPageValues(requestResult(statusesResult), "statuses", head);
  requireEvidence(
    validCheckRuns(checks, head) &&
      statuses.every(
        (status) =>
          positiveInteger(status?.id) &&
          nonemptyString(status.context) &&
          ["success", "failure", "error", "pending"].includes(status.state),
      ) &&
      new Set(statuses.map((status) => status.context)).size === statuses.length,
    "invalid, duplicate, or mismatched check identities",
  );
  const matchingChecks = checks.filter(matchesRequired);
  const candidates = yield* latestRequiredChecksSteps(repo, head, matchingChecks);
  // Check-runs silently omit suites beyond 1,000. Fresh suite success also
  // prevents an earlier check page from hiding a rerun that has just started.
  const suites = yield* checkPagesSteps(
    repo,
    `/commits/${head}/check-suites?per_page=100`,
    "check_suites",
    head,
  );
  requireEvidence(
    suites.length <= 1_000 &&
      new Set(suites.map((suite) => suite.id)).size === suites.length &&
      suites.every(
        (suite) =>
          positiveInteger(suite?.id) &&
          suite.head_sha === head &&
          positiveInteger(suite.app?.id) &&
          nonemptyString(suite.status) &&
          (suite.conclusion === null || nonemptyString(suite.conclusion)),
      ),
    "REST cannot prove complete check-suite evidence",
  );
  const represented = new Set(matchingChecks.map((check) => check.check_suite?.id));
  const unrepresented = suites.filter(
    (suite) =>
      required.some(({ app }) => app === null || app === suite.app.id) &&
      !represented.has(suite.id) &&
      !(suite.status === "completed" && suite.conclusion === "success"),
  );
  for (const suite of unrepresented) {
    requireEvidence(
      (suite.latest_check_runs_count === 0 ||
        (suite.status === "completed" && nonemptyString(suite.conclusion))) &&
        nonemptyString(suite.updated_at) &&
        Number.isSafeInteger(suite.latest_check_runs_count) &&
        suite.latest_check_runs_count >= 0,
      "new required-app check suite has no complete check evidence",
    );
  }
  if (unrepresented.length > 0) {
    // The commit endpoint covers at most 1,000 suites, not 1,000 check runs.
    // The complete suite inventory above bounds that documented truncation.
    // Read all checks once, then reread suites after their checks, rather than
    // making two requests per empty installed-app suite or skipped labeler.
    const complete = yield* checkPagesSteps(
      repo,
      `/commits/${head}/check-runs?filter=latest&per_page=100`,
      "check_runs",
      head,
    );
    requireEvidence(validCheckRuns(complete, head), "invalid complete check-run identities");
    const bySuite = new Map(suites.map((suite) => [suite.id, []]));
    for (const check of complete) {
      const scoped = bySuite.get(check.check_suite?.id);
      requireEvidence(scoped, "check run has no inventoried suite");
      scoped.push(check);
    }
    for (const suite of unrepresented) {
      const scoped = bySuite.get(suite.id);
      requireEvidence(
        scoped.length === suite.latest_check_runs_count &&
          scoped.every((check) => check.app.id === suite.app.id) &&
          !scoped.some(matchesRequired),
        "terminal suite contains missing or required check evidence",
      );
    }
    const current = yield* checkPagesSteps(
      repo,
      `/commits/${head}/check-suites?per_page=100`,
      "check_suites",
      head,
    );
    const currentById = new Map(current.map((suite) => [suite?.id, suite]));
    requireEvidence(
      current.length === suites.length &&
        currentById.size === suites.length &&
        suites.every((suite) => currentById.has(suite.id)),
      "check-suite inventory changed while proving checks irrelevant",
    );
    for (const suite of unrepresented) {
      const fresh = currentById.get(suite.id);
      requireEvidence(
        fresh.head_sha === head &&
          fresh.app?.id === suite.app.id &&
          fresh.status === suite.status &&
          fresh.conclusion === suite.conclusion &&
          fresh.updated_at === suite.updated_at &&
          fresh.latest_check_runs_count === suite.latest_check_runs_count,
        "terminal suite changed while proving its checks irrelevant",
      );
    }
  }
  for (const check of candidates) {
    if (check.status !== "completed" || check.conclusion !== "success") {
      continue;
    }
    const suite = suites.find((value) => value.id === check.check_suite?.id);
    requireEvidence(
      suite?.head_sha === head &&
        suite.app?.id === check.app.id &&
        suite.status === "completed" &&
        suite.conclusion === "success",
      "required check suite is not freshly successful",
    );
  }
  const rows = [];
  for (const { context, app } of required) {
    const matchingStatuses = statuses.filter((status) => status.context === context);
    const boundChecks = candidates
      .filter((check) => check.name === context && (app === null || check.app.id === app))
      .map((check) => {
        const state = (
          check.status === "completed" ? (check.conclusion ?? "UNKNOWN") : check.status
        ).toUpperCase();
        return includeCheckIdentity
          ? {
              state,
              checkRunId: check.id,
              checkSuiteId: check.check_suite?.id,
              publisherId: check.app.id,
            }
          : { state };
      });
    const matches = [
      ...boundChecks,
      ...(app !== null && boundChecks.length === 0 ? [{ state: "EXPECTED" }] : []),
      ...matchingStatuses.map((status) =>
        includeCheckIdentity
          ? { state: status.state.toUpperCase(), statusId: status.id }
          : { state: status.state.toUpperCase() },
      ),
    ];
    for (const match of matches.length > 0 ? matches : [{ state: "EXPECTED" }]) {
      rows.push({ name: context, bucket: bucket(match.state), ...match });
    }
  }
  return canonical(rows);
}

function observationResult(repo, snapshot, current, priorCiObservation) {
  return {
    data: {
      repository: {
        id: snapshot.authority.node_id,
        databaseId: snapshot.authority.id,
        url: repo.url,
        nameWithOwner: repo.nameWithOwner,
        ref: { target: { oid: snapshot.main } },
        pullRequest: pullRequest(current),
      },
    },
    restPolicy: snapshot.policy,
    ...(priorCiObservation ? { mainBefore: snapshot.mainBefore } : {}),
    transport: "rest",
  };
}

export async function withPriorCiObservation(repo, pr, { prepare, finish }) {
  const startedAtMs = Date.now();
  const [authorityResult, mainResult, policyResult, recordResult] = await Promise.allSettled([
    execPrGhAsync(apiArgs(repo, "", ["--include"]), { encoding: "utf8" }, "plain"),
    runReadStepsAsync(readSteps(repo, "/git/ref/heads/main")),
    readMergePolicyAsync(repo),
    execPrGhAsync(apiArgs(repo, `/pulls/${pr}`, ["--include"]), { encoding: "utf8" }, "plain"),
  ]);
  const response = parseGithubResponse(requestResult(authorityResult));
  const authority = repositoryAuthority(repo, response);
  const startingMain = mainReference(requestResult(mainResult));
  const record = validatePullRequest(
    repo,
    authority,
    pr,
    parseGithubResponse(requestResult(recordResult)),
  );
  const policy = record.merged ? null : requestResult(policyResult);
  requireRestSupport(
    record.merged || authority.permissions?.admin === true || authority.permissions?.push === true,
    "repository write access changed",
  );
  const shared = {
    policy,
    main: startingMain,
    head: record.head.sha,
    repositoryId: authority.id,
  };
  const prepared = await prepare(shared);
  const checks =
    record.state === "open"
      ? await readRequiredMergeChecksAsync(repo, record.head.sha, policy, {
          includeCheckIdentity: true,
        })
      : undefined;
  const [currentResult, currentPolicyResult] = await Promise.allSettled([
    execPrGhAsync(apiArgs(repo, `/pulls/${pr}`, ["--include"]), { encoding: "utf8" }, "plain"),
    readMergePolicyAsync(repo),
  ]);
  const current = validatePullRequest(
    repo,
    authority,
    pr,
    parseGithubResponse(requestResult(currentResult)),
  );
  const sameIdentity = samePullRequestIdentity(current, record);
  const samePolicy =
    current.merged || JSON.stringify(requestResult(currentPolicyResult)) === JSON.stringify(policy);
  const finalMain = mainReference(await runReadStepsAsync(readSteps(repo, "/git/ref/heads/main")));
  const finishedAtMs = Date.now();
  console.error(
    `REST merge observation: ${JSON.stringify({
      transport: "rest",
      requestedGhRoute: "plain",
      observedGhRoute: "unrecorded",
      requestedCacheControl: "max-age=0",
      mainBefore: startingMain,
      mainAfter: finalMain,
      startedAtMs,
      finishedAtMs,
      elapsedMs: finishedAtMs - startedAtMs,
    })}`,
  );
  requireEvidence(sameIdentity, "PR identity, head, or lifecycle changed while reading evidence");
  requireEvidence(samePolicy, "branch policy changed while reading evidence");
  // Review, security, and final writer authority follow the final main read.
  const value = await finish(prepared, { ...shared, checks: checks ?? [], main: finalMain });
  return {
    observation: observationResult(
      repo,
      {
        authority,
        main: finalMain,
        mainBefore: startingMain,
        policy:
          checks === undefined
            ? policy
            : {
                ...policy,
                requiredChecks: canonical(
                  checks.map(({ name, bucket: checkBucket, state }) => ({
                    name,
                    bucket: checkBucket,
                    state,
                  })),
                ),
              },
      },
      current,
      true,
    ),
    value,
    qualifiedMain: finalMain,
  };
}

function mergeBody(value) {
  const snapshot = JSON.parse(value);
  requireEvidence(
    typeof snapshot?.base64 === "string" && /^[0-9a-f]{64}$/.test(snapshot.sha256 ?? ""),
    "invalid merge body snapshot",
  );
  const bytes = Buffer.from(snapshot.base64, "base64");
  requireEvidence(
    bytes.toString("base64") === snapshot.base64 &&
      !bytes.includes(0) &&
      createHash("sha256").update(bytes).digest("hex") === snapshot.sha256,
    "merge body snapshot checksum does not match",
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function asyncMergeResponse(repo, pr, head, uuid, payload) {
  const args = apiArgs(repo, `/pulls/${pr}/merge-async${uuid ? `/${uuid}` : ""}`, [
    "--include",
    ...(uuid ? [] : ["--method", "PUT", "--input", "-"]),
  ]);
  // Old protected Octopool rejects this header before generic JSON rewriting.
  // Keep it first: older parsers can delegate on an unknown flag like --hostname.
  args.splice(1, 0, "-H", "X-Octopool-Require: merge-async-v1");
  let raw;
  try {
    raw = execPrGh(
      args,
      { encoding: "utf8", ...(uuid ? {} : { input: JSON.stringify(payload) }) },
      "plain",
    );
  } catch (error) {
    const conflict = parseGithubResponse(String(error.stdout ?? ""));
    if (!uuid && conflict.status === "409" && UUID.test(conflict.body?.details?.uuid ?? "")) {
      requireEvidence(
        false,
        `async request ${conflict.body.details.uuid} already exists; inspect its options and ownership without resubmitting`,
      );
    }
    throw error;
  }
  const response = parseGithubResponse(raw);
  const result = response.body;
  const details = result?.details;
  requireEvidence(
    (uuid ? response.status === "200" : ["200", "202"].includes(response.status)) &&
      ["pending", "merged", "enqueued", "failed"].includes(result?.status) &&
      typeof details?.message === "string" &&
      details.message.length <= 4096,
    "invalid async merge response; reconcile the retained intent without resubmitting",
  );
  if (result.status === "pending") {
    requireEvidence(
      UUID.test(details.uuid ?? "") &&
        (!uuid || details.uuid === uuid) &&
        details.expected_head_sha === head &&
        details.merge_method === "squash" &&
        details.merge_action === "direct_merge" &&
        (details.bypass_rules === undefined || details.bypass_rules === false),
      "async merge request does not match the prepared head and direct squash options",
    );
  } else if (result.status === "merged") {
    requireEvidence(OID.test(details.sha ?? ""), "async merge result has no valid commit");
  }
  requireEvidence(
    result.status === "merged" || details.sha == null,
    "unmerged async result unexpectedly contains a commit",
  );
  requireEvidence(
    response.status !== "202" || result.status === "pending",
    "async acceptance did not return a pending request UUID",
  );
  return {
    uuid: uuid ?? details.uuid ?? null,
    status: result.status,
    message: details.message,
    sha: result.status === "merged" ? details.sha : null,
  };
}

async function main([
  mode,
  repository,
  prValue,
  head,
  bodySnapshot,
  expectedObservation,
  ...extra
]) {
  if (mode === "merge-result") {
    requireEvidence(
      /^[1-9][0-9]*$/.test(prValue ?? "") &&
        Number.isSafeInteger(Number(prValue)) &&
        UUID.test(head ?? "") &&
        OID.test(bodySnapshot ?? "") &&
        expectedObservation === undefined &&
        extra.length === 0,
      "invalid async merge status arguments",
    );
    process.stdout.write(
      `${JSON.stringify(
        asyncMergeResponse(parseMergeRepository(repository), Number(prValue), bodySnapshot, head),
      )}\n`,
    );
    return;
  }
  const observing = ["observe", "observe-admission", "observe-prior-ci"].includes(mode);
  const priorCiObservation = mode === "observe-prior-ci";
  requireEvidence(
    (observing || ["checks", "preview", "projection", "merge"].includes(mode)) &&
      /^[1-9][0-9]*$/.test(prValue ?? "") &&
      Number.isSafeInteger(Number(prValue)) &&
      extra.length === 0 &&
      (mode === "merge"
        ? OID.test(head ?? "") &&
          nonemptyString(bodySnapshot) &&
          nonemptyString(expectedObservation)
        : head === undefined),
    "invalid command arguments",
  );
  const repo = parseMergeRepository(repository);
  const pr = Number(prValue);
  const body = mode === "merge" ? mergeBody(bodySnapshot) : undefined;
  if (mode === "projection") {
    const response = parseGithubResponse(
      execPrGh(apiArgs(repo, `/pulls/${pr}`, ["--include"]), { encoding: "utf8" }, "plain"),
    );
    const record = response.body;
    requireEvidence(
      response.status === "200" &&
        record?.number === pr &&
        [true, false, null].includes(record.mergeable) &&
        MERGE_STATES.has(record.mergeable_state),
      "invalid mergeability hint",
    );
    process.stdout.write(
      `${JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              mergeable:
                record.mergeable === null
                  ? "UNKNOWN"
                  : record.mergeable
                    ? "MERGEABLE"
                    : "CONFLICTING",
              mergeStateStatus: record.mergeable_state.toUpperCase(),
            },
          },
        },
      })}\n`,
    );
    return;
  }
  if (priorCiObservation) {
    const { observation } = await withPriorCiObservation(repo, pr, {
      prepare: async () => undefined,
      finish: async () => undefined,
    });
    process.stdout.write(`${JSON.stringify(observation)}\n`);
    return;
  }
  const snapshot = beginRead(repo, pr, observing);
  const checks =
    mode === "checks" || ((observing || mode === "merge") && snapshot.record.state === "open")
      ? readRequiredMergeChecks(repo, snapshot.record.head.sha, snapshot.policy)
      : undefined;
  if (mode !== "checks" && checks !== undefined) {
    requireEvidence(
      priorCiObservation || checks.every((check) => check.bucket === "pass"),
      "required checks are not passing",
    );
    snapshot.policy.requiredChecks = checks;
  }
  const current = finishRead(
    repo,
    pr,
    snapshot,
    observing && mode !== "observe-admission" && !priorCiObservation,
    priorCiObservation,
  );
  if (observing && !priorCiObservation && current.state === "open") {
    // REST can still be calculating after GraphQL is ready. Select the alternate
    // reader before retaining intent; mutation dispatch never changes transports.
    requireRestSupport(
      current.mergeable === true && current.mergeable_state === "clean",
      "merge projection requires GraphQL admission",
    );
  }
  let result;
  if (mode === "checks") {
    result = checks;
  } else if (mode === "preview") {
    requireEvidence(
      nonemptyString(current.user?.login) &&
        ["User", "Bot"].includes(current.user?.type) &&
        (current.body === null || typeof current.body === "string"),
      "missing squash preview author or body",
    );
    result = {
      data: {
        repository: {
          squashMergeCommitTitle: snapshot.authority.squash_merge_commit_title,
          squashMergeCommitMessage: snapshot.authority.squash_merge_commit_message,
          pullRequest: {
            headRefOid: current.head.sha,
            author: { login: current.user.login, __typename: current.user.type },
            isMergeQueueEnabled: false,
            viewerMergeBodyText: current.body ?? "",
          },
        },
      },
      transport: "rest",
    };
  } else if (observing) {
    result = observationResult(repo, snapshot, current, priorCiObservation);
  } else {
    // The async endpoint also merges downstack PRs. This owner admits one PR;
    // GitHub includes `stack` on REST resources belonging to a stack.
    requireEvidence(
      current.stack == null,
      "stacked PRs require review and authorization of the full stack",
    );
    requireEvidence(
      current.state === "open" &&
        !current.draft &&
        current.head.sha === head &&
        current.mergeable === true &&
        current.mergeable_state === "clean" &&
        nonemptyString(current.title),
      "immediate squash requires the prepared open, non-draft, clean PR head",
    );
    const { main: _main, ...expectedFacts } = JSON.parse(expectedObservation);
    requireEvidence(
      JSON.stringify(
        canonical({
          pr: pullRequest(current),
          transport: "rest",
          restPolicy: snapshot.policy,
        }),
      ) === JSON.stringify(canonical(expectedFacts)),
      "PR or policy changed before merge dispatch",
    );
    const payload = {
      sha: head,
      merge_method: "squash",
      merge_action: "direct_merge",
      bypass_rules: false,
      commit_message: body,
    };
    result = asyncMergeResponse(repo, pr, head, undefined, payload);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error.code === "OPENCLAW_GH_ACCESS"
        ? error.message
        : String(error.stderr || error.message).trim(),
    );
    if (
      [
        "observe",
        "observe-admission",
        "observe-prior-ci",
        "checks",
        "preview",
        "projection",
      ].includes(process.argv[2]) &&
      (error.code === "OPENCLAW_REST_MERGED_RECEIPT_UNAVAILABLE" ||
        (process.argv[2] !== "observe-prior-ci" &&
          (error.coreQuotaExhausted || error.code === "OPENCLAW_REST_UNSUPPORTED")))
    ) {
      process.stdout.write('{"restUnavailable":true}\n');
    } else {
      process.exitCode = Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
    }
  }
}
