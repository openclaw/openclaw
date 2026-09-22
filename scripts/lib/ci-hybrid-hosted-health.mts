const HOSTED_SENTINELS = new Set([
  "check-guards",
  "check-npm-lock",
  "check-prod-types",
  "check-docs",
  "control-ui-i18n",
  "native-i18n",
]);
const MAX_WAIT_SECONDS = 180;
const FRESHNESS_MS = 30 * 60 * 1_000;

type HostedHealth = {
  healthy: boolean;
  reason: string;
  sampledJobs: number;
  maxWaitSeconds: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Actions response");
  }
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid Actions timestamp");
  }
  return parsed;
}

export async function inspectHybridHostedHealth({
  repository,
  runId,
  token,
}: {
  repository: string;
  runId: string;
  token: string;
}): Promise<HostedHealth> {
  const result = {
    healthy: false,
    reason: "no-fresh-hosted-evidence",
    sampledJobs: 0,
    maxWaitSeconds: 0,
  };
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^\d+$/u.test(runId) || !token) {
    return { ...result, reason: "hosted-health-unavailable" };
  }
  const now = Date.now();
  const cutoff = now - FRESHNESS_MS;
  const signal = AbortSignal.timeout(10_000);
  const readRows = async (path: string, key: string) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) {
      throw new Error("Actions request failed");
    }
    const body = record(await response.json());
    if (!Array.isArray(body[key])) {
      throw new Error("Invalid Actions response");
    }
    return body[key].map(record);
  };
  try {
    // Bound the server-side history too: an unrestricted high-volume listing
    // can omit recent matches even though individual fresh runs are available.
    const query = new URLSearchParams({
      branch: "main",
      event: "push",
      per_page: "10",
      created: `>=${new Date(now - 24 * 60 * 60 * 1_000).toISOString()}`,
    });
    const runs = (await readRows(`workflows/ci.yml/runs?${query}`, "workflow_runs"))
      .filter(
        (run) =>
          String(run.id) !== runId &&
          run.conclusion !== "cancelled" &&
          run.conclusion !== "skipped" &&
          (run.status === "in_progress" || run.status === "completed") &&
          timestamp(run.updated_at) >= cutoff &&
          run.event === "push" &&
          run.head_branch === "main" &&
          record(run.head_repository).full_name === repository,
      )
      .slice(0, 3);
    let assignedJobs = 0;
    for (const run of runs) {
      if (
        typeof run.id !== "number" ||
        !Number.isSafeInteger(run.id) ||
        run.id <= 0 ||
        typeof run.run_attempt !== "number" ||
        !Number.isSafeInteger(run.run_attempt) ||
        run.run_attempt <= 0
      ) {
        throw new Error("Invalid Actions run");
      }
      const jobs = await readRows(
        `runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
        "jobs",
      );
      const preflight = jobs.find(
        (job) =>
          job.name === "preflight" &&
          job.run_attempt === run.run_attempt &&
          job.status === "completed" &&
          job.conclusion === "success",
      );
      if (!preflight) {
        continue;
      }
      const readyAt = timestamp(preflight.completed_at);
      for (const job of jobs) {
        if (
          typeof job.name !== "string" ||
          !HOSTED_SENTINELS.has(job.name) ||
          job.run_attempt !== run.run_attempt ||
          job.conclusion === "cancelled" ||
          job.conclusion === "skipped"
        ) {
          continue;
        }
        if (!Array.isArray(job.labels)) {
          throw new Error("Invalid Actions labels");
        }
        if (!job.labels.includes("ubuntu-24.04") || job.labels.includes("self-hosted")) {
          continue;
        }
        const assigned = typeof job.runner_id === "number" && job.runner_id > 0;
        if (!assigned && job.status !== "queued") {
          throw new Error("Hosted assignment evidence unavailable");
        }
        const observedAt = assigned ? timestamp(job.started_at) : now;
        // These sentinels depend only on preflight; creation may precede that dependency.
        const eligibleAt = Math.max(timestamp(job.created_at), readyAt);
        if (observedAt < cutoff || eligibleAt > observedAt || observedAt > now) {
          continue;
        }
        const waitSeconds = Math.floor((observedAt - eligibleAt) / 1_000);
        result.sampledJobs += 1;
        result.maxWaitSeconds = Math.max(result.maxWaitSeconds, waitSeconds);
        if (waitSeconds >= MAX_WAIT_SECONDS) {
          return { ...result, reason: "hosted-assignment-stalled" };
        }
        assignedJobs += Number(assigned);
      }
    }
    return assignedJobs > 0
      ? { ...result, healthy: true, reason: "hosted-assignment-healthy" }
      : result;
  } catch {
    return { ...result, reason: "hosted-health-unavailable" };
  }
}
