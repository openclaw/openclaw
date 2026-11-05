import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./record-shared.mjs";
import {
  pollRelease,
  probeCapabilities,
  ReleaseRefusal,
  requireReleaseValue as requireValue,
  shellCommand,
  type ReleaseContext,
} from "./release-stable-state.mts";
import { parseJson, positiveInteger, readReleaseRun } from "./release-stable-workflows.mts";

const DRY_SHA = "a".repeat(40);
const HOUR = 60 * 60 * 1_000;

async function ensureToolingTag(ctx: ReleaseContext, sha: string): Promise<string> {
  let tag = ctx.state.validate.toolingTag;
  const fresh = !tag;
  tag ??= `release-publish/${sha.slice(0, 12)}-${Math.floor(Date.now() / 1_000)}`;
  ctx.state.validate.toolingTag = tag;
  ctx.save();
  const verify = () =>
    ctx.run("gh", ["api", `repos/${ctx.state.repo}/git/ref/tags/${tag}`, "--jq", ".object.sha"], {
      allowFailure: true,
      dryRunStdout: sha,
    });
  if (!fresh) {
    const existing = await verify();
    if (existing.exitCode === 0) {
      if (existing.stdout.trim() !== sha) {
        throw new ReleaseRefusal(`Tooling tag ${tag} does not point to ${sha}.`, [
          ctx.resume("validate"),
        ]);
      }
      return tag;
    }
  }
  const local = await ctx.run("git", ["tag", tag, sha], { allowFailure: true });
  if (local.exitCode !== 0) {
    const existing = await ctx.run("git", ["rev-parse", `refs/tags/${tag}`]);
    if (existing.stdout.trim() !== sha) {
      throw new ReleaseRefusal(`Local tooling tag ${tag} does not point to ${sha}.`, [
        ctx.resume("validate"),
      ]);
    }
  }
  await ctx.run("git", ["push", "origin", `refs/tags/${tag}`], { allowFailure: true });
  let result = await verify();
  if (result.exitCode !== 0) {
    await ctx.run(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `repos/${ctx.state.repo}/git/refs`,
        "-f",
        `ref=refs/tags/${tag}`,
        "-f",
        `sha=${sha}`,
      ],
      { allowFailure: true },
    );
    result = await verify();
  }
  if (result.exitCode !== 0 || result.stdout.trim() !== sha) {
    throw new ReleaseRefusal(`Cannot verify tooling tag ${tag} at ${sha}.`, [
      ctx.resume("validate"),
    ]);
  }
  return tag;
}

export async function validate(ctx: ReleaseContext): Promise<void> {
  const { state, options } = ctx;
  ctx.log("validate", "preparing candidate qualification and independent publication tooling");
  const sha =
    options.toolingSha ??
    state.validate.toolingSha ??
    (await ctx.run("git", ["rev-parse", "origin/main"], { dryRunStdout: DRY_SHA })).stdout.trim();
  if (state.validate.toolingSha && state.validate.toolingSha !== sha) {
    throw new ReleaseRefusal(
      `Tooling is already pinned to ${state.validate.toolingSha}; use a separate state directory for a new validation request.`,
      [
        ctx.resume("cut", [
          "--state-dir",
          `${options.stateDir}-tooling-${sha.slice(0, 12)}`,
          "--cut-sha",
          requireValue(state.cut.cutSha, "cut SHA"),
          "--tooling-sha",
          sha,
        ]),
      ],
    );
  }
  if (
    (
      await ctx.run("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
        allowFailure: true,
      })
    ).exitCode !== 0
  ) {
    throw new ReleaseRefusal(`Tooling SHA ${sha} is not an ancestor of origin/main.`, [
      ctx.resume("validate"),
    ]);
  }
  state.validate.toolingSha = sha;
  ctx.save();
  await probeCapabilities(ctx, sha);
  const tag = await ensureToolingTag(ctx, sha);
  const requestFile = state.validate.requestFile ?? join(options.stateDir, "frv-request.json");
  state.validate.requestFile = requestFile;
  ctx.save();
  const args = [
    "ci:full-release",
    "--",
    "--sha",
    requireValue(state.cut.releaseSha, "release SHA"),
    "--target-ref",
    state.branch,
    "--workflow-sha",
    requireValue(state.cut.releaseSha, "release SHA"),
    "--trusted-workflow-ref",
    "candidate",
    "--admission-workflow-sha",
    sha,
    "--admission-workflow-ref",
    tag,
    "--request-file",
    requestFile,
    "--",
    "-f",
    "validation_purpose=publish",
    "-f",
    'publication_selection_json={"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}',
    "-f",
    "release_profile=stable",
    "-f",
    "run_release_soak=true",
  ];
  // validate.toolingSha/tag retain their publication (P) meaning, including old
  // state. The retained helper request owns Q and all original dispatch inputs.
  const retained = !ctx.options.dryRun && existsSync(requestFile);
  if (!ctx.options.dryRun && state.validate.runId && !retained) {
    throw new ReleaseRefusal(
      `Missing retained Full Release Validation request ${requestFile} for run ${state.validate.runId}; restore the original request before recovery.`,
      [shellCommand("pnpm", ["frv", "status", "--run", state.validate.runId])],
    );
  }
  await ctx.run(
    "pnpm",
    retained ? ["ci:full-release", "--", "--reconcile-request", requestFile] : args,
    { allowFailure: true },
  );
  let request: unknown;
  try {
    request = ctx.options.dryRun
      ? { phase: "observed", run: { id: 100, attempt: 1 } }
      : parseJson(readFileSync(requestFile, "utf8"), requestFile);
  } catch {
    request = undefined;
  }
  if (
    !isRecord(request) ||
    request.phase !== "observed" ||
    !isRecord(request.run) ||
    !positiveInteger(request.run.id) ||
    !positiveInteger(request.run.attempt)
  ) {
    throw new ReleaseRefusal(
      `Full Release Validation request ${requestFile} has no observed run.`,
      [
        shellCommand("pnpm", ["ci:full-release", "--", "--reconcile-request", requestFile]),
        ...(isRecord(request) &&
        request.kind === "openclaw.full-release-dispatch/v2" &&
        request.phase === "prepared" &&
        isRecord(request.request) &&
        request.request.trustedWorkflowRef === "candidate" &&
        isRecord(request.refs) &&
        request.refs.workflow === "intended"
          ? [shellCommand("pnpm", ["ci:full-release", "--", "--resume-request", requestFile])]
          : []),
        ctx.resume("validate"),
      ],
    );
  }
  const id = String(request.run.id);
  if (!ctx.options.dryRun) {
    const identity = request.request;
    const candidateOwned = isRecord(identity) && identity.trustedWorkflowRef === "candidate";
    const expected = {
      targetSha: state.cut.releaseSha,
      targetContextRef: state.branch,
      workflowSha: candidateOwned ? state.cut.releaseSha : sha,
      trustedWorkflowRef: candidateOwned ? "candidate" : tag,
      targetVersion: state.release,
      repository: state.repo,
    };
    if (
      !isRecord(identity) ||
      Object.entries(expected).some(([key, value]) => identity[key] !== value) ||
      (candidateOwned &&
        (!isRecord(request.admission) ||
          request.admission.workflowSha !== sha ||
          request.admission.workflowRef !== tag)) ||
      !isRecord(identity.inputs) ||
      identity.inputs.release_profile !== "stable" ||
      identity.effectiveSoak !== true
    ) {
      throw new ReleaseRefusal(
        `Retained Full Release Validation request ${requestFile} does not match this release, tooling, and strict stable validation selection.`,
        [
          shellCommand("pnpm", ["ci:full-release", "--", "--reconcile-request", requestFile]),
          ctx.resume("validate"),
        ],
      );
    }
  }
  state.validate.runId = id;
  state.validate.runAttempt = request.run.attempt;
  ctx.save();
  const run = await pollRelease(ctx, {
    label: `Full Release Validation ${id}`,
    timeoutMs: 4 * HOUR,
    next: [ctx.resume("validate")],
    probe: async () => {
      const current = await readReleaseRun(ctx, state.repo, id);
      return current.status === "completed" ? current : undefined;
    },
  });
  if (run.conclusion !== "success") {
    throw new ReleaseRefusal(
      `Full Release Validation ${id} failed; diagnose before operator recovery.`,
      [shellCommand("pnpm", ["frv", "status", "--run", id]), ctx.resume("validate")],
    );
  }
  state.validate.runAttempt = Number(run.run_attempt);
  ctx.save();
}
