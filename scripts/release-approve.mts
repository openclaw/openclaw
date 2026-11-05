#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const ENVIRONMENTS = ["npm-release", "mac-release"] as const;
type ReleaseEnvironment = (typeof ENVIRONMENTS)[number];

function ghJson(args: string[]): unknown {
  return JSON.parse(
    execFileSync("gh", ["api", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function gh(args: string[]): void {
  execFileSync("gh", ["api", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

function approvalReconciliationError({
  endpoint,
  environment,
  environmentId,
  repo,
  runId,
  submitted,
}: {
  endpoint: string;
  environment: string;
  environmentId: number;
  repo: string;
  runId: number;
  submitted: boolean;
}): Error {
  const approvalsEndpoint = `repos/${repo}/actions/runs/${runId}/approvals`;
  return new Error(
    [
      `Approval for ${environment} (${environmentId}) on run ${runId} ${submitted ? "was submitted" : "may have been submitted"}, but its effect was not confirmed.`,
      "Do not retry this approval until its state is reconciled with these read-only checks:",
      `  gh api ${endpoint}`,
      `  gh api ${approvalsEndpoint}`,
      `Retry only if ${environment} (${environmentId}) is still pending and no approved review is recorded.`,
    ].join("\n"),
  );
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return id;
}

export async function runReleaseApproval(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      run: { type: "string" },
      env: { type: "string" },
      sha: { type: "string" },
      release: { type: "string" },
      workflow: { type: "string" },
      ref: { type: "string" },
      repo: { type: "string", default: "openclaw/openclaw" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const runId = positiveId(values.run, "--run");
  const environment = values.env;
  if (!ENVIRONMENTS.includes(environment as ReleaseEnvironment)) {
    throw new Error(`--env must be one of ${ENVIRONMENTS.join(", ")}`);
  }
  const releaseEnvironment = environment as ReleaseEnvironment;
  if (!values.sha || !/^[a-f0-9]{40}$/u.test(values.sha)) {
    throw new Error("--sha must be a full lowercase commit SHA");
  }
  if (!values.release || !/^\d{4}\.\d{1,2}\.\d+(?:-[a-z0-9.-]+)?$/u.test(values.release)) {
    throw new Error("--release must be an exact OpenClaw release version");
  }
  if (!values.workflow || !/^[A-Za-z0-9_.-]+\.ya?ml$/u.test(values.workflow)) {
    throw new Error("--workflow must be an exact workflow filename");
  }
  if (!values.ref || !/^[A-Za-z0-9._/-]+$/u.test(values.ref)) {
    throw new Error("--ref must be an exact GitHub head branch");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(values.repo)) {
    throw new Error("--repo must be owner/name");
  }

  const run = ghJson([`repos/${values.repo}/actions/runs/${runId}`]);
  if (!isRecord(run) || positiveId(run.id, "GitHub run id") !== runId) {
    throw new Error(`GitHub returned invalid run metadata for ${runId}`);
  }
  const headSha = typeof run.head_sha === "string" ? run.head_sha : "";
  if (headSha !== values.sha) {
    throw new Error(`Run ${runId} head SHA ${headSha} does not match ${values.sha}`);
  }
  const workflowPath = (typeof run.path === "string" ? run.path : "").split("@", 1)[0];
  if (workflowPath !== `.github/workflows/${values.workflow}`) {
    throw new Error(`Run ${runId} workflow ${workflowPath} does not match ${values.workflow}`);
  }
  const headBranch = typeof run.head_branch === "string" ? run.head_branch : "";
  if (headBranch !== values.ref) {
    throw new Error(`Run ${runId} head ref ${headBranch} does not match ${values.ref}`);
  }
  const displayTitle = typeof run.display_title === "string" ? run.display_title : "";
  const escapedRelease = values.release.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    !new RegExp(`(?:^|[^0-9A-Za-z.-])v?${escapedRelease}(?:$|[^0-9A-Za-z.-])`, "u").test(
      displayTitle,
    )
  ) {
    throw new Error(`Run ${runId} title does not identify release ${values.release}`);
  }
  const status = typeof run.status === "string" ? run.status : "";
  if (!["queued", "in_progress", "waiting"].includes(status)) {
    throw new Error(`Run ${runId} is not active (status=${status})`);
  }

  const endpoint = `repos/${values.repo}/actions/runs/${runId}/pending_deployments`;
  const pending = ghJson([endpoint]);
  if (!Array.isArray(pending)) {
    throw new Error(`GitHub returned invalid pending deployments for ${runId}`);
  }
  const matches = pending.filter(
    (deployment) =>
      isRecord(deployment) &&
      isRecord(deployment.environment) &&
      deployment.environment.name === releaseEnvironment,
  );
  if (matches.length !== 1 || !isRecord(matches[0]?.environment)) {
    throw new Error(
      `Expected exactly one pending ${releaseEnvironment} deployment for run ${runId}`,
    );
  }
  if (matches[0].current_user_can_approve !== true) {
    throw new Error(
      `Authenticated GitHub identity cannot approve ${releaseEnvironment} for run ${runId}`,
    );
  }
  const environmentId = positiveId(
    matches[0].environment.id,
    `${releaseEnvironment} environment id`,
  );
  const user = ghJson(["user"]);
  const login = isRecord(user) && typeof user.login === "string" ? user.login : undefined;
  if (!login) {
    throw new Error("GitHub returned no effective approving identity");
  }

  const approvalArgs = [
    "-X",
    "POST",
    endpoint,
    "-f",
    "state=approved",
    "-f",
    `comment=${values.release} ${releaseEnvironment} approved by ${login}`,
    "-F",
    `environment_ids[]=${environmentId}`,
  ];
  if (values["dry-run"]) {
    console.log(
      `Would approve ${releaseEnvironment} for ${values.repo} run ${runId} at ${values.sha} as ${login}`,
    );
    return;
  }
  try {
    gh(approvalArgs);
  } catch {
    throw approvalReconciliationError({
      endpoint,
      environment: releaseEnvironment,
      environmentId,
      repo: values.repo,
      runId,
      submitted: false,
    });
  }

  let remaining: unknown;
  try {
    remaining = ghJson([endpoint]);
  } catch {
    throw approvalReconciliationError({
      endpoint,
      environment: releaseEnvironment,
      environmentId,
      repo: values.repo,
      runId,
      submitted: true,
    });
  }
  if (
    !Array.isArray(remaining) ||
    remaining.some(
      (deployment) =>
        isRecord(deployment) &&
        isRecord(deployment.environment) &&
        deployment.environment.id === environmentId,
    )
  ) {
    throw approvalReconciliationError({
      endpoint,
      environment: releaseEnvironment,
      environmentId,
      repo: values.repo,
      runId,
      submitted: true,
    });
  }
  console.log(
    `Approved ${releaseEnvironment} for ${values.repo} run ${runId} at ${values.sha} as ${login}`,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runReleaseApproval();
}
