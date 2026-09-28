import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TERMINAL_FAILURES = new Set(["failure", "timed_out"]);
const CONTROL_JOBS = new Set(["pr-fail-fast", "openclaw/ci-gate"]);

/** @param {unknown} value */
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Actions response");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>[]} planners */
function plannedCheckJobCount(planners) {
  if (planners.length === 0) {
    return undefined;
  }
  const planner = planners[0];
  if (!planner || planners.length !== 1) {
    throw new Error("Actions returned multiple check planners");
  }
  if (planner.status !== "completed") {
    return undefined;
  }
  if (planner.conclusion !== "success" || !Array.isArray(planner.steps)) {
    throw new Error("Check planner has no successful count fact");
  }
  const markers = planner.steps
    .map(record)
    .filter((step) => typeof step.name === "string" && step.name.startsWith("CI check job count"));
  const marker = markers[0];
  const match =
    typeof marker?.name === "string"
      ? /^CI check job count v1: (0|[1-9]\d*)$/u.exec(marker.name)
      : null;
  const count = match ? Number(match[1]) : Number.NaN;
  if (
    markers.length !== 1 ||
    !marker ||
    marker.status !== "completed" ||
    marker.conclusion !== "success" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 400
  ) {
    throw new Error("Check planner has no valid completed count fact");
  }
  return count;
}

/**
 * @param {{repository: string, runId: number, runAttempt: number,
 * pullRequestNumber: number, headSha: string, expectedJobCount: number,
 * preflightCheckJobCount: number, checkPlanExpected: boolean, token: string,
 * recordFailure: (job: {id: number, name: string, runAttempt: number}) => void}} options
 */
export async function monitorPrFailure(options) {
  const {
    repository,
    runId,
    runAttempt,
    pullRequestNumber,
    headSha,
    expectedJobCount,
    preflightCheckJobCount,
    checkPlanExpected,
    token,
  } = options;
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(repository) ||
    !/^[a-f0-9]{40}$/u.test(headSha) ||
    ![runId, runAttempt, pullRequestNumber, expectedJobCount].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    expectedJobCount > 400 ||
    !Number.isSafeInteger(preflightCheckJobCount) ||
    preflightCheckJobCount < 0 ||
    preflightCheckJobCount > expectedJobCount ||
    typeof checkPlanExpected !== "boolean" ||
    !token
  ) {
    throw new Error("Invalid PR cancellation context");
  }
  // Partial reruns reuse successful jobs; their attempt inventory is not the
  // complete manifest. Native matrix fail-fast remains active on those runs.
  if (runAttempt !== 1) {
    return "retry";
  }
  // GitHub's job budget includes checkout, so derive the cutoff from the
  // attempt's own monitor start rather than when this script finally starts.
  let observationDeadline;
  const root = `https://api.github.com/repos/${repository}`;
  /** @param {string} route @param {string} [method] */
  const request = async (route, method = "GET") => {
    const response = await fetch(`${root}${route}`, {
      method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Actions ${method} returned HTTP ${response.status}`);
    }
    return method === "POST" ? {} : record(await response.json());
  };
  const runRoute = `/actions/runs/${runId}`;
  /** @param {Record<string, unknown>} run */
  const matchesRun = (run) =>
    run.id === runId &&
    run.run_attempt === runAttempt &&
    run.event === "pull_request" &&
    run.head_sha === headSha &&
    run.path === ".github/workflows/ci.yml" &&
    record(run.repository).full_name === repository &&
    record(run.head_repository).full_name === repository;
  const initial = await request(runRoute);
  if (!matchesRun(initial)) {
    throw new Error("PR cancellation run identity changed");
  }
  if (initial.status === "completed") {
    return "completed";
  }
  const workflowId = initial.workflow_id;
  const runNumber = initial.run_number;
  const branch = initial.head_branch;
  if (
    typeof workflowId !== "number" ||
    typeof runNumber !== "number" ||
    typeof branch !== "string"
  ) {
    throw new Error("Invalid Actions workflow identity");
  }

  const isCurrent = async () => {
    const pull = await request(`/pulls/${pullRequestNumber}`);
    const head = record(pull.head);
    const base = record(pull.base);
    if (
      pull.state !== "open" ||
      pull.draft ||
      head.sha !== headSha ||
      record(head.repo).full_name !== repository ||
      record(base.repo).full_name !== repository ||
      head.ref !== branch
    ) {
      return false;
    }
    const query = new URLSearchParams({ event: "pull_request", branch, per_page: "10" });
    const recent = await request(`/actions/workflows/${workflowId}/runs?${query}`);
    if (!Array.isArray(recent.workflow_runs)) {
      throw new Error("Invalid Actions run inventory");
    }
    if (
      recent.workflow_runs.some((value) => {
        const run = record(value);
        return (
          run.event === "pull_request" &&
          run.workflow_id === workflowId &&
          record(run.head_repository).full_name === repository &&
          run.head_branch === branch &&
          typeof run.run_number === "number" &&
          run.run_number > runNumber
        );
      })
    ) {
      return false;
    }
    const current = await request(runRoute);
    // GitHub can report queued while selected jobs are already running.
    return matchesRun(current) && (current.status === "queued" || current.status === "in_progress");
  };

  while (observationDeadline === undefined || Date.now() < observationDeadline) {
    /** @type {Map<number, {id: number, name: string, status: string, conclusion: string | null, completedAt: string | null}>} */
    const jobs = new Map();
    /** @type {Map<number, Record<string, unknown>>} */
    const checkPlanners = new Map();
    for (let page = 1; page <= 4; page++) {
      const body = await request(
        `/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
      );
      if (
        !Array.isArray(body.jobs) ||
        typeof body.total_count !== "number" ||
        !Number.isSafeInteger(body.total_count) ||
        body.total_count > 400
      ) {
        throw new Error("Invalid or oversized Actions job inventory");
      }
      for (const value of body.jobs) {
        const job = record(value);
        if (
          job.run_id !== runId ||
          job.run_attempt !== runAttempt ||
          typeof job.id !== "number" ||
          !Number.isSafeInteger(job.id) ||
          typeof job.name !== "string" ||
          typeof job.status !== "string" ||
          (job.conclusion !== null && typeof job.conclusion !== "string")
        ) {
          throw new Error("Actions job identity changed");
        }
        if (job.name === "check-plan") {
          checkPlanners.set(job.id, job);
        }
        if (job.name === "pr-fail-fast") {
          const startedAt =
            typeof job.started_at === "string" ? Date.parse(job.started_at) : Number.NaN;
          if (Number.isFinite(startedAt)) {
            // Reserve five minutes for bounded API requests and cancellation cleanup.
            observationDeadline = startedAt + 55 * 60_000;
          }
        }
        if (!CONTROL_JOBS.has(job.name)) {
          jobs.set(job.id, {
            id: job.id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            completedAt: typeof job.completed_at === "string" ? job.completed_at : null,
          });
        }
      }
      if (page * 100 >= body.total_count) {
        break;
      }
    }
    const rows = [...jobs.values()];
    const failed = rows
      .filter(
        (job) =>
          job.status === "completed" &&
          job.conclusion !== null &&
          TERMINAL_FAILURES.has(job.conclusion),
      )
      .toSorted((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))[0];
    if (failed) {
      if (!(await isCurrent())) {
        return "superseded";
      }
      // Record the verified cause before the one write. An accepted request can
      // lose its response; ci-gate must still fail rather than skip in that case.
      options.recordFailure({ id: failed.id, name: failed.name, runAttempt });
      await request(`${runRoute}/cancel`, "POST");
      return "failure-cancelled";
    }
    if (observationDeadline === undefined) {
      return "observation-unavailable";
    }
    if (Date.now() >= observationDeadline) {
      return "observation-expired";
    }
    if (rows.some((job) => job.conclusion === "cancelled")) {
      return "externally-cancelled";
    }
    // Failure observation starts immediately; only clean completion waits for
    // the installed planner's successful, attempt-bound inventory publication.
    const checkCount = checkPlanExpected
      ? plannedCheckJobCount([...checkPlanners.values()])
      : preflightCheckJobCount;
    if (checkCount !== undefined && checkCount > preflightCheckJobCount) {
      throw new Error("Check planner exceeded its preflight inventory");
    }
    const finalJobCount =
      checkCount === undefined ? undefined : expectedJobCount - preflightCheckJobCount + checkCount;
    if (
      finalJobCount !== undefined &&
      rows.filter((job) => job.status === "completed" && job.conclusion !== "skipped").length >=
        finalJobCount
    ) {
      return "completed";
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 30_000);
    });
  }
  return "observation-expired";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let recordedFailure = false;
  try {
    const reason = await monitorPrFailure({
      repository: process.env.GITHUB_REPOSITORY ?? "",
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      pullRequestNumber: Number(process.env.OPENCLAW_CI_PR_NUMBER),
      headSha: process.env.OPENCLAW_CI_PR_HEAD_SHA ?? "",
      expectedJobCount: Number(process.env.OPENCLAW_CI_EXPECTED_JOBS),
      preflightCheckJobCount: Number(process.env.OPENCLAW_CI_PREFLIGHT_CHECK_JOBS),
      checkPlanExpected: process.env.OPENCLAW_CI_CHECK_PLAN_EXPECTED === "true",
      token: process.env.GITHUB_TOKEN ?? "",
      recordFailure(job) {
        const name = job.name.replace(/[\r\n`]/gu, " ");
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `failure_job_id=${job.id}\nfailure_job_name=${name}\nfailure_run_attempt=${job.runAttempt}\n`,
        );
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `Stopping PR CI after **${name}** failed (job ${job.id}).\n`,
        );
        recordedFailure = true;
      },
    });
    console.log(`PR failure monitor: ${reason}`);
  } catch (error) {
    // Observation failures must not turn otherwise healthy CI red. Tests and
    // ci-gate retain their normal coverage; an uncertain cancellation stays red.
    console.error(
      `::warning::PR failure monitor unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    if (recordedFailure) {
      process.exitCode = 1;
    }
  }
}
