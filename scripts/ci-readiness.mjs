import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { execPlainGh } from "./lib/plain-gh.mjs";
import { parseGithubResponse } from "./pr-lib/gh-api-preflight.mjs";

export const READINESS_PREFIX = "ci:ready:";
const shaPattern = /^[0-9a-f]{40}$/;
const lifecycleRevocations = new Set([
  "closed",
  "reopened",
  // Issue-ledger spelling differs from pull_request's converted_to_draft action.
  "convert_to_draft",
  "ready_for_review",
  "base_ref_changed",
  "head_ref_force_pushed",
]);

export function validatePolicy(policy) {
  if (
    policy?.version !== 1 ||
    !["off", "canary", "all"].includes(policy.mode) ||
    !Array.isArray(policy.pullRequests) ||
    policy.pullRequests.length > 10 ||
    policy.pullRequests.some((number) => !Number.isSafeInteger(number) || number < 1)
  ) {
    throw new Error(
      "Invalid CI readiness policy (version 1; off/canary/all; at most 10 canary PRs)",
    );
  }
  return policy;
}

function candidate(pr) {
  if (
    !Number.isSafeInteger(pr?.number) ||
    !shaPattern.test(pr.head?.sha) ||
    !shaPattern.test(pr.base?.sha) ||
    !pr.head?.repo?.full_name ||
    !pr.base?.repo?.full_name ||
    !pr.head?.ref ||
    !pr.base?.ref
  ) {
    throw new Error("Incomplete pull request candidate");
  }
  return [
    pr.base.repo.full_name,
    pr.number,
    pr.head.repo.full_name,
    pr.head.ref,
    pr.head.sha,
    pr.base.ref,
    pr.base.sha,
  ];
}

export function readinessLabel(pr, policy) {
  validatePolicy(policy);
  const binding = [
    candidate(pr),
    policy.version,
    policy.mode,
    policy.pullRequests.toSorted((a, b) => a - b),
  ];
  return (
    READINESS_PREFIX +
    createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 40)
  );
}

function sameCandidate(left, right, allowBaseAdvance = false) {
  const identity = (pr) => (allowBaseAdvance ? candidate(pr).slice(0, -1) : candidate(pr));
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

function assertOpen(pr, repository) {
  if (pr.state !== "open" || pr.draft || pr.base.repo.full_name !== repository) {
    throw new Error(
      "CI readiness requires a current open, non-draft PR in the selected repository",
    );
  }
}

function inRollout(pr, policy) {
  return (
    policy.mode === "all" || (policy.mode === "canary" && policy.pullRequests.includes(pr.number))
  );
}

async function requireWriter(api, repository, actor, expectedId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\[bot\])?$/.test(actor ?? "")) {
    throw new Error("Missing CI readiness requester");
  }
  const result = await api(
    `repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
  );
  if (!["admin", "maintain", "write"].includes(result.permission)) {
    throw new Error("CI readiness requester no longer has repository write permission");
  }
  if (
    expectedId !== undefined &&
    (!Number.isSafeInteger(expectedId) || result.user?.id !== expectedId)
  ) {
    throw new Error("CI readiness requester identity changed");
  }
}

// Read the existing issue event ledger, not a new admission database. A bounded
// incomplete ledger is unknown, never authorization. IDs order simultaneous events.
async function requestEvent(api, repository, number, label) {
  const events = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(
      `repos/${repository}/issues/${number}/events?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) {
      throw new Error("Invalid PR event ledger");
    }
    events.push(...batch);
    if (batch.length < 100) {
      const relevant = events.filter(
        (event) =>
          lifecycleRevocations.has(event.event) ||
          (["labeled", "unlabeled"].includes(event.event) && event.label?.name === label),
      );
      relevant.sort((a, b) => b.id - a.id);
      const latest = relevant[0];
      if (latest?.event !== "labeled" || !Number.isSafeInteger(latest.id)) {
        throw new Error("CI readiness request was revoked or has no authoritative label event");
      }
      return latest;
    }
  }
  throw new Error("PR event ledger exceeds the readiness bound; retain ordinary CI until reviewed");
}

export async function inspectReadiness({
  api,
  repository,
  event,
  policy,
  testedSha,
  requestId = "",
  triggeringActor = "",
}) {
  validatePolicy(policy);
  const original = event.pull_request;
  candidate(original);
  const enforced = inRollout(original, policy);
  const labelEvent = ["labeled", "unlabeled"].includes(event.action);
  if (!enforced) {
    return {
      broad_ci: String(!original.draft && original.state === "open" && !labelEvent),
      enforced: "false",
      reason: labelEvent ? "Readiness rollout is disabled for this PR" : "Ordinary event-driven CI",
    };
  }
  const deferred = (reason) => ({ broad_ci: "false", enforced: "true", reason });
  assertOpen(original, repository);
  const label = readinessLabel(original, policy);
  if (event.action === "labeled" && event.label?.name !== label) {
    throw new Error("CI readiness request does not match this candidate");
  }
  if (event.action !== "labeled") {
    return deferred(`Awaiting explicit readiness request ${label} for this candidate`);
  }
  const pullPath = `repos/${repository}/pulls/${original.number}`;
  const current = await api(pullPath);
  assertOpen(current, repository);
  if (
    !sameCandidate(original, current, Boolean(requestId)) ||
    (!requestId && current.merge_commit_sha !== testedSha)
  ) {
    throw new Error("CI readiness candidate or tested merge revision was superseded");
  }
  // Normal main advancement does not invalidate completed proof of this run's
  // original merge tree. Preserve non-strict required-check policy, but never
  // accept a base rewrite or retarget as ordinary advancement.
  if (requestId && original.base.sha !== current.base.sha) {
    const comparison = await api(
      `repos/${repository}/compare/${original.base.sha}...${current.base.sha}`,
    );
    if (comparison.status !== "ahead" || comparison.merge_base_commit?.sha !== original.base.sha) {
      throw new Error("CI readiness base was rewritten, not advanced");
    }
  }
  if (!current.labels.some((item) => item.name === label)) {
    throw new Error("CI readiness label was removed");
  }
  const request = await requestEvent(api, repository, original.number, label);
  if (
    request.actor?.login !== event.sender?.login ||
    !Number.isSafeInteger(request.actor?.id) ||
    request.actor.id !== event.sender?.id ||
    (requestId && String(request.id) !== requestId)
  ) {
    throw new Error("CI readiness request identity changed");
  }
  await requireWriter(api, repository, request.actor.login, request.actor.id);
  if (triggeringActor && triggeringActor !== request.actor.login) {
    await requireWriter(api, repository, triggeringActor);
  }
  // Recheck lifecycle/candidate after the awaited authority reads, both before
  // planner fanout and again at result acceptance. Labels never change source trust.
  const finalRequest = await requestEvent(api, repository, original.number, label);
  const finalPr = await api(pullPath);
  assertOpen(finalPr, repository);
  if (
    finalRequest.id !== request.id ||
    !sameCandidate(current, finalPr) ||
    (!requestId && finalPr.merge_commit_sha !== testedSha) ||
    !finalPr.labels.some((item) => item.name === label)
  ) {
    throw new Error("CI readiness authority changed during admission");
  }
  return {
    broad_ci: "true",
    enforced: "true",
    request_id: String(request.id),
    reason: `Ready request ${request.id}; head ${current.head.sha}; base ${original.base.sha}; tested ${testedSha}; requester ${request.actor.login}`,
  };
}

function githubCliApi(path, { method = "GET", body } = {}) {
  const args = ["api", "--method", method, path, "-H", "Cache-Control: max-age=0"];
  // Included headers keep /user on the protected writer route, not a pooled reader.
  if (path === "user") {
    args.push("--include");
  }
  const directory = body === undefined ? undefined : mkdtempSync(join(tmpdir(), "ci-readiness-"));
  try {
    if (directory) {
      const input = join(directory, "request.json");
      writeFileSync(input, JSON.stringify(body), { mode: 0o600 });
      args.push("--input", input);
    }
    const text = execPlainGh(args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (path === "user") {
      const response = parseGithubResponse(text);
      if (response.status !== "200" || !response.body) {
        throw new Error("Missing authenticated writer identity response");
      }
      return response.body;
    }
    return text.trim() ? JSON.parse(text) : null;
  } catch (error) {
    error.status = Number(String(error.stderr ?? "").match(/\(HTTP (\d{3})\)/)?.[1]) || undefined;
    throw error;
  } finally {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

export async function requestReadiness({ api, repository, number, head, base }) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !shaPattern.test(head) ||
    !shaPattern.test(base)
  ) {
    throw new Error("request requires --repo owner/name --pr number --head SHA --base SHA");
  }
  const pullPath = `repos/${repository}/pulls/${number}`;
  const pr = await api(pullPath);
  candidate(pr);
  if (pr.head.sha !== head || pr.base.sha !== base) {
    throw new Error("Requested candidate is no longer current");
  }
  let file;
  try {
    file = await api(`repos/${repository}/contents/.github/ci-readiness.json?ref=${base}`);
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    return { status: "disabled", reason: "Base has no readiness policy; ordinary CI applies" };
  }
  const policy = validatePolicy(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")));
  if (!inRollout(pr, policy)) {
    return { status: "disabled", reason: "PR is outside the checked-in readiness rollout" };
  }
  assertOpen(pr, repository);
  const actor = await api("user");
  if (!Number.isSafeInteger(actor.id)) {
    throw new Error("Missing requester account identity");
  }
  await requireWriter(api, repository, actor.login, actor.id);
  const label = readinessLabel(pr, policy);
  if (pr.labels.some((item) => item.name === label)) {
    // An uncertain earlier POST is reconciled by this same branch; never remove
    // and re-add automatically, which would start a second run.
    const request = await requestEvent(api, repository, number, label);
    return {
      status: "attach",
      label,
      requestId: request.id,
      reason: "Request already exists; inspect its CI run, do not dispatch again",
    };
  }
  // Add-label accepts an existing repository label. Create only when absent;
  // concurrent creators reconcile the deterministic name after a failed write.
  const labelPath = `repos/${repository}/labels/${encodeURIComponent(label)}`;
  try {
    await api(labelPath);
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    try {
      await api(`repos/${repository}/labels`, {
        method: "POST",
        body: {
          name: label,
          color: "0e8a16",
          description: "One exact PR candidate CI request; not merge or credential authority",
        },
      });
    } catch {
      await api(labelPath);
    }
  }
  await requireWriter(api, repository, actor.login, actor.id);
  const finalPr = await api(pullPath);
  assertOpen(finalPr, repository);
  if (!sameCandidate(pr, finalPr)) {
    throw new Error("Candidate changed before readiness request");
  }
  if (finalPr.labels.some((item) => item.name === label)) {
    return { status: "attach", label };
  }
  try {
    await api(`repos/${repository}/issues/${number}/labels`, {
      method: "POST",
      body: { labels: [label] },
    });
  } catch (error) {
    const observed = await api(pullPath);
    if (!observed.labels.some((item) => item.name === label)) {
      throw error;
    }
    return {
      status: "attach",
      label,
      reason: "Write acknowledgement uncertain; label exists, inspect the existing run",
    };
  }
  const observed = await api(pullPath);
  if (!sameCandidate(pr, observed) || !observed.labels.some((item) => item.name === label)) {
    throw new Error("Readiness write requires reconciliation; do not automatically resubmit");
  }
  return { status: "requested", label, head, base };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      policy: { type: "string" },
      "request-id": { type: "string" },
    },
  });
  if (command === "request") {
    console.log(
      JSON.stringify(
        await requestReadiness({
          api: githubCliApi,
          repository: values.repo,
          number: Number(values.pr),
          head: values.head,
          base: values.base,
        }),
      ),
    );
    return;
  }
  if (command !== "inspect") {
    throw new Error("Use request or inspect");
  }
  const result = await inspectReadiness({
    api: githubCliApi,
    repository: process.env.GITHUB_REPOSITORY,
    event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
    policy: JSON.parse(readFileSync(values.policy, "utf8")),
    testedSha: process.env.GITHUB_SHA,
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
    requestId: values["request-id"],
  });
  if (values["request-id"] && result.broad_ci !== "true") {
    throw new Error(result.reason);
  }
  for (const [key, value] of Object.entries(result)) {
    if (key !== "reason") {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### PR CI readiness\n\n${result.reason}\n`);
  console.log(result.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
