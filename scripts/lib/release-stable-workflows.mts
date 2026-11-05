import { isRecord } from "./record-shared.mjs";
import {
  pollRelease,
  ReleaseRefusal,
  shellCommand,
  type ReleaseContext,
  type ReleasePhase,
} from "./release-stable-state.mts";

export function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${label}.`);
  }
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function readReleaseRun(ctx: ReleaseContext, repo: string, id: string) {
  const result = await ctx.run("gh", ["api", `repos/${repo}/actions/runs/${id}`], {
    dryRunStdout: JSON.stringify({ status: "completed", conclusion: "success", run_attempt: 1 }),
  });
  const run = parseJson(result.stdout, `run ${id}`);
  if (!isRecord(run) || typeof run.status !== "string" || !positiveInteger(run.run_attempt)) {
    throw new Error(`Invalid Actions run ${id}.`);
  }
  return run;
}

export async function listReleaseRuns(
  ctx: ReleaseContext,
  endpoint: string,
): Promise<Record<string, unknown>[]> {
  const response = await ctx.run("gh", ["api", endpoint], { dryRunStdout: '{"workflow_runs":[]}' });
  const body = parseJson(response.stdout, endpoint);
  if (!isRecord(body) || !Array.isArray(body.workflow_runs)) {
    throw new Error(`Invalid workflow run list from ${endpoint}.`);
  }
  return body.workflow_runs.filter(isRecord);
}

export async function dispatchReleaseWorkflow(
  ctx: ReleaseContext,
  params: {
    phase: ReleasePhase;
    workflow: string;
    repo: string;
    ref: string;
    inputs: string[];
    excludeRunIds?: string[];
  },
): Promise<{ id: string; dispatchedAt: string }> {
  const { workflow, repo, ref, phase, inputs } = params;
  const event = `dispatch-intent:${workflow}`;
  const previous = ctx.state.history.findLast(
    (entry) => entry.phase === phase && entry.event === event,
  );
  const detail = JSON.stringify({ workflow, repo, ref, inputs });
  if (previous && previous.detail !== detail) {
    throw new ReleaseRefusal(
      `The retained ${workflow} dispatch has different inputs; reconcile it before changing publication inputs.`,
      [
        shellCommand("gh", [
          "run",
          "list",
          "--repo",
          repo,
          "--workflow",
          workflow,
          "--json",
          "databaseId,createdAt,headBranch,displayTitle",
        ]),
        ctx.resume(phase),
      ],
    );
  }
  if (!ctx.state.operator.login) {
    const identity = await ctx.run("gh", ["api", "user", "--jq", ".login"], {
      dryRunStdout: "operator",
    });
    const login = identity.stdout.trim();
    if (!login) {
      throw new ReleaseRefusal("Cannot identify the workflow dispatching operator.", [
        ctx.resume(phase),
      ]);
    }
    ctx.state.operator.login = login;
    ctx.save();
  }
  const next = [
    shellCommand("gh", [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      workflow,
      "--json",
      "databaseId,createdAt,headBranch,displayTitle",
    ]),
    ctx.resume(phase),
  ];
  const dispatchedAt = previous?.at ?? new Date().toISOString();
  const args = [
    "workflow",
    "run",
    workflow,
    "--repo",
    repo,
    "--ref",
    ref,
    ...inputs.flatMap((input) => ["-f", input]),
  ];
  if (!previous) {
    ctx.state.history.push({
      at: dispatchedAt,
      phase,
      event,
      detail,
    });
    ctx.save();
    await ctx.run("gh", args, { allowFailure: true });
  }
  let polls = 0;
  const id = await pollRelease(ctx, {
    label: `dispatch of ${workflow}`,
    timeoutMs: 10 * 60 * 1_000,
    next,
    probe: async () => {
      const runs = await listReleaseRuns(
        ctx,
        `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`,
      );
      if (ctx.options.dryRun) {
        if (phase === "macos") {
          return "204";
        }
        return workflow.includes("validate") ? "201" : workflow.includes("macos") ? "202" : "203";
      }
      const candidates = runs.filter(
        (run) =>
          typeof run.path === "string" &&
          run.path.endsWith(`/${workflow}`) &&
          run.head_branch === ref &&
          run.event === "workflow_dispatch" &&
          isRecord(run.actor) &&
          run.actor.login === ctx.state.operator.login &&
          !params.excludeRunIds?.includes(String(run.id)) &&
          typeof run.created_at === "string" &&
          Date.parse(run.created_at) >= Date.parse(dispatchedAt) - 60_000 &&
          Date.parse(run.created_at) <= Date.parse(dispatchedAt) + 10 * 60_000 &&
          (typeof run.display_title !== "string" ||
            !run.display_title.match(/v\d{4}\.\d{1,2}\.\d+(?:-[a-z0-9.]+)?/gu)?.length ||
            run.display_title
              .match(/v\d{4}\.\d{1,2}\.\d+(?:-[a-z0-9.]+)?/gu)
              ?.includes(ctx.state.tag)) &&
          positiveInteger(run.id),
      );
      if (candidates.length > 1) {
        throw new ReleaseRefusal(
          `Ambiguous dispatch of ${workflow}: runs ${candidates.map((run) => run.id).join(", ")}`,
          next,
        );
      }
      if (candidates[0]) {
        return String(candidates[0].id);
      }
      if (++polls >= 10) {
        throw new ReleaseRefusal(
          `Could not reconcile ${workflow}; the dispatch may have been accepted.`,
          next,
        );
      }
      return undefined;
    },
  });
  return { id, dispatchedAt };
}

export async function pendingDeployments(
  ctx: ReleaseContext,
  repo: string,
  id: string,
): Promise<Record<string, unknown>[]> {
  const result = await ctx.run(
    "gh",
    ["api", `repos/${repo}/actions/runs/${id}/pending_deployments`],
    { dryRunStdout: "[]" },
  );
  const deployments = parseJson(result.stdout, `pending deployments for ${id}`);
  if (!Array.isArray(deployments)) {
    throw new Error(`Invalid pending deployments for ${id}.`);
  }
  return deployments.filter(isRecord);
}

export async function approveReleaseGates(
  ctx: ReleaseContext,
  repo: string,
  id: string,
  environment: "npm-release" | "mac-release",
): Promise<void> {
  if (!ctx.state.operator.publicationApproved) {
    throw new ReleaseRefusal("Publication approval is required before approving release gates.", [
      ctx.resume("publish", ["--approve-publication"]),
    ]);
  }
  for (const pending of await pendingDeployments(ctx, repo, id)) {
    if (
      !isRecord(pending.environment) ||
      pending.environment.name !== environment ||
      !positiveInteger(pending.environment.id)
    ) {
      continue;
    }
    const receipt = `${id}:${pending.environment.id}`;
    if (ctx.state.publish.approvedGates.includes(receipt)) {
      continue;
    }
    await ctx.run("gh", [
      "api",
      "-X",
      "POST",
      `repos/${repo}/actions/runs/${id}/pending_deployments`,
      "-f",
      "state=approved",
      "-f",
      `comment=${ctx.state.release} stable publish approved by ${ctx.state.operator.name}`,
      "-F",
      `environment_ids[]=${pending.environment.id}`,
    ]);
    ctx.state.publish.approvedGates.push(receipt);
    ctx.save();
  }
}

export function manualSweepCommands(ctx: ReleaseContext): string[] {
  const repo = ctx.state.repo;
  const endpoint = `repos/${repo}/actions/runs/<child>/pending_deployments`;
  return [
    "# Inspect ownership; reject and cancel only superseded children of this publish parent.",
    ...["waiting", "queued"].map((status) =>
      shellCommand("gh", [
        "api",
        `repos/${repo}/actions/runs?status=${status}&per_page=100`,
        "--jq",
        '.workflow_runs[] | select(.event=="workflow_dispatch" and .actor.login=="github-actions[bot]") | select(.name | test("plugin-clawhub|Plugin ClawHub Release|Plugin NPM Release|OpenClaw NPM Release|openclaw-npm-release")) | [.id,.name,.created_at] | @tsv',
      ]),
    ),
    `env_id=$(${shellCommand("gh", ["api", endpoint, "--jq", ".[0].environment.id"])})`,
    `${shellCommand("gh", ["api", "-X", "POST", endpoint, "-f", "state=rejected", "-f", "comment=Reject stale release gate"])} -F "environment_ids[]=$env_id"`,
    shellCommand("gh", ["run", "cancel", "<child>", "--repo", repo]),
  ];
}
