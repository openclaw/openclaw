import { createHash } from "node:crypto";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { parseGithubResponse } from "./gh-api-preflight.mjs";
import { execPrGh, execPrGhJson } from "./github.mjs";

const OID = /^[0-9a-f]{40}$/;
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

function requireRestSupport(condition, message) {
  if (!condition) {
    const error = new Error(`REST merge: ${message}; use GraphQL.`);
    error.code = "OPENCLAW_REST_UNSUPPORTED";
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

function parseRepository(value) {
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

function readMain(repo) {
  const reference = read(repo, "/git/ref/heads/main");
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

function readPolicy(repo) {
  let response;
  try {
    response = execPrGh(
      apiArgs(repo, "/branches/main/protection", ["--include"]),
      {
        encoding: "utf8",
      },
      "plain",
    );
  } catch (error) {
    // A missing classic protection rule is authoritative only with its HTTP body;
    // stderr, inaccessible repositories, and generic 404s do not prove absence.
    response = String(error.stdout ?? "");
    const parsed = parseGithubResponse(response);
    if (parsed.status !== "404" || parsed.body?.message !== "Branch not protected") {
      throw error;
    }
  }
  const protection = parseGithubResponse(response);
  requireRestSupport(
    protection.status === "404" && protection.body?.message === "Branch not protected",
    "classic branch protection is not supported",
  );
  const rules = pageArrays(read(repo, "/rules/branches/main?per_page=100", true));
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
  return canonical({ classicProtection: null, rules });
}

function readPullRequest(repo, authority, pr) {
  const record = read(repo, `/pulls/${pr}`);
  requireEvidence(
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
      ["open", "closed"].includes(record.state) &&
      typeof record.merged === "boolean" &&
      typeof record.draft === "boolean" &&
      [true, false, null].includes(record.mergeable) &&
      nonemptyString(record.mergeable_state) &&
      Object.hasOwn(record, "auto_merge") &&
      (record.auto_merge === null ||
        ["squash", "merge", "rebase"].includes(record.auto_merge?.merge_method)),
    "invalid PR identity or lifecycle evidence",
  );
  requireRestSupport(
    record.state !== "open" || (!record.merged && record.auto_merge === null),
    "open PR already has an auto-merge request or inconsistent lifecycle",
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

function beginRead(repo, pr, observe) {
  // Included headers select the protected writer route, so pooled-reader
  // permissions cannot establish the actor's access to branch policy.
  const response = parseGithubResponse(
    execPrGh(apiArgs(repo, "", ["--include"]), { encoding: "utf8" }, "plain"),
  );
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
  const mainSha = readMain(repo);
  const record = readPullRequest(repo, authority, pr);
  // An already-merged receipt proves a historical action. New protection or
  // reduced privileges cannot invalidate the retained head and tree proof.
  const receipt = observe && record.merged;
  requireRestSupport(
    receipt || authority.permissions?.admin === true,
    "policy-reader admin access changed",
  );
  const policy = receipt ? null : readPolicy(repo);
  return { authority, main: mainSha, record, policy };
}

function finishRead(repo, pr, snapshot, requireStableMain) {
  const current = readPullRequest(repo, snapshot.authority, pr);
  const identity = (record) => {
    const {
      mergeable: _mergeable,
      mergeStateStatus: _mergeStateStatus,
      ...facts
    } = pullRequest(record);
    return facts;
  };
  requireEvidence(
    JSON.stringify(identity(current)) === JSON.stringify(identity(snapshot.record)),
    "PR identity, head, or lifecycle changed while reading evidence",
  );
  const mainSha = readMain(repo);
  requireEvidence(
    !requireStableMain || current.merged || mainSha === snapshot.main,
    "main changed while reading evidence",
  );
  snapshot.main = mainSha;
  return current;
}

function checkPages(repo, endpoint, key, head) {
  const pages = read(repo, endpoint, true);
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

function latestRequiredChecks(repo, head, checks) {
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
  const runs = checkPages(
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

function requiredChecks(repo, snapshot) {
  const requirements = new Map();
  for (const rule of snapshot.policy.rules) {
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
  const head = snapshot.record.head.sha;
  const contexts = new Set(required.map(({ context }) => context));
  const nameFilter =
    contexts.size === 1 ? `&check_name=${encodeURIComponent(required[0].context)}` : "";
  const checks = checkPages(
    repo,
    `/commits/${head}/check-runs?filter=latest${nameFilter}&per_page=100`,
    "check_runs",
    head,
  );
  const statuses = checkPages(repo, `/commits/${head}/status?per_page=100`, "statuses", head);
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
  const candidates = latestRequiredChecks(repo, head, matchingChecks);
  // Check-runs silently omit suites beyond 1,000. Fresh suite success also
  // prevents an earlier check page from hiding a rerun that has just started.
  const suites = checkPages(
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
  for (const suite of suites) {
    const requiredApp = required.some(({ app }) => app === null || app === suite.app.id);
    if (
      !requiredApp ||
      represented.has(suite.id) ||
      (suite.status === "completed" && suite.conclusion === "success")
    ) {
      continue;
    }
    requireEvidence(
      (suite.latest_check_runs_count === 0 ||
        (suite.status === "completed" && nonemptyString(suite.conclusion))) &&
        nonemptyString(suite.updated_at) &&
        Number.isSafeInteger(suite.latest_check_runs_count) &&
        suite.latest_check_runs_count >= 0,
      "new required-app check suite has no complete check evidence",
    );
    // Empty installed-app suites and skipped labelers contribute no required
    // context only when their own complete, stable check result proves that.
    const scoped = checkPages(
      repo,
      `/check-suites/${suite.id}/check-runs?filter=latest&per_page=100`,
      "check_runs",
      head,
    );
    requireEvidence(
      scoped.length === suite.latest_check_runs_count &&
        validCheckRuns(scoped, head) &&
        scoped.every(
          (check) => check.check_suite?.id === suite.id && check.app.id === suite.app.id,
        ) &&
        !scoped.some(matchesRequired),
      "terminal suite contains missing or required check evidence",
    );
    const current = read(repo, `/check-suites/${suite.id}`);
    requireEvidence(
      current?.id === suite.id &&
        current.head_sha === head &&
        current.app?.id === suite.app.id &&
        current.status === suite.status &&
        current.conclusion === suite.conclusion &&
        current.updated_at === suite.updated_at &&
        current.latest_check_runs_count === suite.latest_check_runs_count,
      "terminal suite changed while proving its checks irrelevant",
    );
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
      .map((check) =>
        (check.status === "completed"
          ? (check.conclusion ?? "UNKNOWN")
          : check.status
        ).toUpperCase(),
      );
    const matches = [
      ...boundChecks,
      ...(app !== null && boundChecks.length === 0 ? ["EXPECTED"] : []),
      ...matchingStatuses.map((status) => status.state.toUpperCase()),
    ];
    for (const state of matches.length > 0 ? matches : ["EXPECTED"]) {
      rows.push({ name: context, bucket: bucket(state), state });
    }
  }
  return canonical(rows);
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

function main([mode, repository, prValue, head, bodySnapshot, expectedObservation, ...extra]) {
  requireEvidence(
    ["observe", "observe-admission", "checks", "preview", "merge"].includes(mode) &&
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
  const repo = parseRepository(repository);
  const pr = Number(prValue);
  const observing = mode === "observe" || mode === "observe-admission";
  const body = mode === "merge" ? mergeBody(bodySnapshot) : undefined;
  const snapshot = beginRead(repo, pr, observing);
  if (observing && snapshot.record.state === "open") {
    requireRestSupport(
      ["clean", "unknown"].includes(snapshot.record.mergeable_state),
      "merge projection requires GraphQL admission",
    );
  }
  const checks =
    mode === "checks" || ((observing || mode === "merge") && snapshot.record.state === "open")
      ? requiredChecks(repo, snapshot)
      : undefined;
  if (mode !== "checks" && checks !== undefined) {
    requireEvidence(
      checks.every((check) => check.bucket === "pass"),
      "required checks are not passing",
    );
    snapshot.policy.requiredChecks = checks;
  }
  const current = finishRead(repo, pr, snapshot, mode === "observe");
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
    result = {
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
      transport: "rest",
    };
  } else {
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
      commit_message: body,
    };
    result = execPrGhJson(
      apiArgs(repo, `/pulls/${pr}/merge`, ["--method", "PUT", "--input", "-"]),
      { input: JSON.stringify(payload), stdio: ["pipe", "pipe", "pipe"] },
      "plain",
    );
    requireEvidence(
      result?.merged === true && OID.test(result.sha ?? ""),
      "merge response did not confirm acceptance; reconcile the retained intent before any further request",
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error.code === "OPENCLAW_GH_ACCESS"
        ? error.message
        : String(error.stderr || error.message).trim(),
    );
    if (
      ["observe", "observe-admission", "checks", "preview"].includes(process.argv[2]) &&
      (error.coreQuotaExhausted || error.code === "OPENCLAW_REST_UNSUPPORTED")
    ) {
      process.stdout.write('{"restUnavailable":true}\n');
    } else {
      process.exitCode = Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
    }
  }
}
