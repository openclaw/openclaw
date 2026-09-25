import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./record-shared.mjs";
import { buildReleasePublishDispatchCommand } from "./release-publish-preflight-interface.mts";
import {
  confirmRelease,
  pollRelease,
  probeCapabilities,
  ReleaseRefusal,
  shellCommand,
  type ReleaseContext,
} from "./release-stable-state.mts";
import {
  approveReleaseGates,
  dispatchReleaseWorkflow,
  listReleaseRuns,
  manualSweepCommands,
  parseJson,
  pendingDeployments,
  positiveInteger,
  readReleaseRun,
} from "./release-stable-workflows.mts";

const DRY_SHA = "a".repeat(40);
const HOUR = 60 * 60 * 1_000;

function requireValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}; complete the preceding release phase.`);
  }
  return value;
}

export async function fetchReleaseMain(ctx: ReleaseContext): Promise<void> {
  const result = await ctx.run("git", ["fetch", "origin", "main:refs/remotes/origin/main"], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    if (/cannot lock ref/u.test(result.stderr)) {
      await ctx.run("git", ["fetch", "origin", "main"]);
    } else {
      throw new Error(result.stderr || "Fetching origin/main failed.");
    }
  }
}

export async function cut(ctx: ReleaseContext): Promise<void> {
  const { state, options } = ctx;
  ctx.log("cut", "fetching the release cut and checking its prepared files");
  await fetchReleaseMain(ctx);
  const main = (
    await ctx.run("git", ["rev-parse", "origin/main"], { dryRunStdout: DRY_SHA })
  ).stdout.trim();
  const cutSha = state.cut.cutSha ?? options.cutSha ?? main;
  state.cut.cutSha = cutSha;
  ctx.save();
  if (state.operator.cutShaConfirmed !== cutSha) {
    const next = [ctx.resume("cut", ["--confirm-cut-sha", cutSha])];
    if (options.confirmCutSha && options.confirmCutSha !== cutSha) {
      throw new ReleaseRefusal(`--confirm-cut-sha does not match the cut SHA ${cutSha}.`, next);
    }
    if (options.confirmCutSha !== cutSha) {
      await confirmRelease(
        ctx,
        `Confirm cut SHA ${cutSha} (origin/main ${main.slice(0, 12)}) for ${state.branch}? [y/N]`,
        next,
      );
    }
    state.operator.cutShaConfirmed = cutSha;
    ctx.save();
  }
  const remote = (
    await ctx.run("git", ["ls-remote", "--heads", "origin", state.branch])
  ).stdout.trim();
  let tip = remote.split(/\s+/u)[0] || cutSha;
  if (!remote) {
    await ctx.run("git", ["push", "origin", `${cutSha}:refs/heads/${state.branch}`]);
  } else {
    await ctx.run("git", ["fetch", "origin", state.branch]);
    tip = (await ctx.run("git", ["rev-parse", "FETCH_HEAD"], { dryRunStdout: tip })).stdout.trim();
    const ancestor = await ctx.run("git", ["merge-base", "--is-ancestor", cutSha, tip], {
      allowFailure: true,
    });
    if (ancestor.exitCode !== 0) {
      throw new ReleaseRefusal(
        `The release branch does not contain cut ${cutSha}; a second cut requires Peter's explicit request.`,
        [ctx.resume("cut", ["--cut-sha", tip])],
      );
    }
  }
  const pkg = await ctx.run("git", ["show", `${tip}:package.json`], {
    allowFailure: true,
    dryRunStdout: JSON.stringify({ version: state.release }),
  });
  const notes = await ctx.run("git", ["show", `${tip}:CHANGELOG/${state.release}.md`], {
    allowFailure: true,
    dryRunStdout: `## ${state.release}`,
  });
  const records = await ctx.run("git", ["show", `${tip}:CHANGELOG/records/${state.release}.md`], {
    allowFailure: true,
  });
  let packageVersion: unknown;
  if (pkg.exitCode === 0) {
    try {
      const manifest = parseJson(pkg.stdout, "release package.json");
      packageVersion = isRecord(manifest) ? manifest.version : undefined;
    } catch {
      packageVersion = undefined;
    }
  }
  if (
    packageVersion !== state.release ||
    notes.exitCode !== 0 ||
    !notes.stdout.includes(`## ${state.release}`) ||
    records.exitCode !== 0
  ) {
    throw new ReleaseRefusal(`Release cut ${tip} is incomplete.`, [
      shellCommand("git", ["switch", state.branch]),
      shellCommand("pnpm", ["release:prepare", "--", "--version", state.release, "--write"]),
      `# Write CHANGELOG/${state.release}.md and CHANGELOG/records/${state.release}.md with $openclaw-changelog-update`,
      "pnpm changelog:check",
      shellCommand("git", ["commit", "-am", `chore(release): cut ${state.release}`]),
      shellCommand("git", ["push", "origin", state.branch]),
      ctx.resume("cut"),
    ]);
  }
  state.cut.releaseSha = tip;
  ctx.save();
}

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
  ctx.log("validate", "preparing frozen tooling and Full Release Validation");
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
    sha,
    "--trusted-workflow-ref",
    tag,
    "--request-file",
    requestFile,
    "--",
    "-f",
    "validation_purpose=publish",
    "-f",
    'publication_selection_json={"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}',
    "-f",
    "release_profile=beta",
    "-f",
    "run_release_soak=false",
  ];
  await ctx.run("pnpm", args, { allowFailure: true });
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
        shellCommand("pnpm", args),
        shellCommand("pnpm", ["ci:full-release", "--", "--reconcile-request", requestFile]),
        ctx.resume("validate"),
      ],
    );
  }
  const id = String(request.run.id);
  if (request.request !== undefined) {
    const identity = request.request;
    const expected = {
      targetSha: state.cut.releaseSha,
      targetContextRef: state.branch,
      workflowSha: sha,
      trustedWorkflowRef: tag,
      targetVersion: state.release,
      repository: state.repo,
    };
    if (
      !isRecord(identity) ||
      Object.entries(expected).some(([key, value]) => identity[key] !== value)
    ) {
      throw new ReleaseRefusal(
        `Retained Full Release Validation request ${requestFile} does not match this release and tooling.`,
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
  for (;;) {
    const run = await pollRelease(ctx, {
      label: `Full Release Validation ${id}`,
      timeoutMs: 4 * HOUR,
      next: [ctx.resume("validate")],
      probe: async () => {
        const current = await readReleaseRun(ctx, state.repo, id);
        return current.status === "completed" ? current : undefined;
      },
    });
    if (run.conclusion === "success") {
      state.validate.runAttempt = Number(run.run_attempt);
      ctx.save();
      break;
    }
    if (state.validate.continues >= 2) {
      throw new ReleaseRefusal(`Full Release Validation ${id} failed after two continues.`, [
        shellCommand("pnpm", ["frv", "status", "--run", id]),
        ctx.resume("validate"),
      ]);
    }
    state.validate.continues += 1;
    ctx.save();
    await ctx.run("pnpm", ["frv", "continue", "--failed", "--run", id]);
  }
  if (options.stableSoakWaiver) {
    state.validate.stableSoakWaiver = options.stableSoakWaiver;
  } else if (!state.validate.stableSoakWaiver) {
    const previous = (
      await ctx.run("npm", ["view", "openclaw", "dist-tags.latest"], { dryRunStdout: "2026.9.1" })
    ).stdout.trim();
    if (!previous || previous === state.release) {
      throw new ReleaseRefusal(
        "The previous stable release is missing or already equals this release; supply the explicit soak waiver.",
        [ctx.resume("validate", ["--stable-soak-waiver", "<reason>"])],
      );
    }
    state.validate.stableSoakWaiver = `Operator-approved by ${state.operator.name} for ${state.release}: beta-profile Full Release Validation ${id} attempt ${state.validate.runAttempt} green; soak, live/E2E, Telegram, QA-live, and Parallels deferred to postpublish confidence; update from ${previous} to the candidate proven.`;
  }
  state.validate.laneWaiver = options.laneWaiver ?? state.validate.laneWaiver ?? "";
  ctx.save();
}

function parsePublishInputs(command: string): Map<string, string> {
  const inputs = new Map<string, string>();
  for (const line of command.split("\n").slice(1)) {
    const match = /^\s+-f (.+?)(?: \\)?$/u.exec(line);
    if (!match?.[1]) {
      throw new Error("Candidate publish command contains an unsupported input line.");
    }
    let value = match[1];
    if (value.startsWith("'") && value.endsWith("'")) {
      const parts = value.slice(1, -1).split("'\\''");
      if (parts.some((part) => part.includes("'"))) {
        throw new Error("Candidate publish input has invalid shell quoting.");
      }
      value = parts.join("'");
    } else if (!/^[a-zA-Z0-9_./:@=-]+$/u.test(value)) {
      throw new Error("Candidate publish input is not a quoted or bare word.");
    }
    const separator = value.indexOf("=");
    const key = value.slice(0, separator);
    if (separator < 1 || !/^[a-z][a-z0-9_]*$/u.test(key) || inputs.has(key)) {
      throw new Error("Candidate publish command has invalid or duplicate inputs.");
    }
    inputs.set(key, value.slice(separator + 1));
  }
  if (!inputs.size) {
    throw new Error("Candidate publish command has no inputs.");
  }
  return inputs;
}

async function reportWaitingChildren(ctx: ReleaseContext, reported: Set<string>): Promise<void> {
  const { state } = ctx;
  if (!state.validate.toolingTag) {
    return;
  }
  const dispatchedAt = requireValue(state.publish.dispatchedAt, "publish dispatch time");
  const children = await listReleaseRuns(
    ctx,
    `repos/${state.repo}/actions/runs?status=waiting&event=workflow_dispatch&per_page=100&created=>=${dispatchedAt}`,
  );
  for (const child of children) {
    if (
      child.head_branch !== state.validate.toolingTag ||
      child.event !== "workflow_dispatch" ||
      child.status !== "waiting" ||
      !isRecord(child.actor) ||
      child.actor.login !== "github-actions[bot]" ||
      typeof child.path !== "string" ||
      !["plugin-npm-release.yml", "openclaw-npm-release.yml"].some(
        (workflow) => child.path === `.github/workflows/${workflow}`,
      ) ||
      typeof child.created_at !== "string" ||
      !(Date.parse(child.created_at) >= Date.parse(dispatchedAt)) ||
      !positiveInteger(child.id) ||
      reported.has(String(child.id))
    ) {
      continue;
    }
    const id = String(child.id);
    for (const pending of await pendingDeployments(ctx, state.repo, id)) {
      if (
        !isRecord(pending.environment) ||
        pending.environment.name !== "npm-release" ||
        !positiveInteger(pending.environment.id)
      ) {
        continue;
      }
      const command = shellCommand("gh", [
        "api",
        "-X",
        "POST",
        `repos/${state.repo}/actions/runs/${id}/pending_deployments`,
        "-f",
        "state=approved",
        "-f",
        `comment=${state.release} stable publish approved by ${state.operator.name}`,
        "-F",
        `environment_ids[]=${pending.environment.id}`,
      ]);
      ctx.log(
        "publish",
        `child ${id} (${child.path.split("/").at(-1)}) waits for npm-release; approve only if it belongs to parent ${state.publish.publishRunId}: ${command}`,
      );
      reported.add(id);
      break;
    }
  }
}

async function ensureFinalTag(ctx: ReleaseContext): Promise<void> {
  const { state } = ctx;
  const sha = requireValue(state.cut.releaseSha, "release SHA");
  const remote = await ctx.run("git", [
    "ls-remote",
    "--tags",
    "origin",
    state.tag,
    `${state.tag}^{}`,
  ]);
  const refs = new Map(
    remote.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [object, ref] = line.split(/\s+/u);
        return [ref, object];
      }),
  );
  if (refs.size) {
    const target = refs.get(`refs/tags/${state.tag}^{}`) ?? refs.get(`refs/tags/${state.tag}`);
    if (target !== sha) {
      throw new ReleaseRefusal(
        `Existing final tag ${state.tag} does not point to ${sha}; tags are never moved.`,
        [ctx.resume("publish")],
      );
    }
    return;
  }
  const tagged = await ctx.run(
    "git",
    ["tag", "-a", state.tag, sha, "-m", `OpenClaw ${state.release}`],
    { allowFailure: true },
  );
  if (tagged.exitCode !== 0) {
    const local = await ctx.run("git", ["rev-parse", `${state.tag}^{}`]);
    if (local.stdout.trim() !== sha) {
      throw new ReleaseRefusal(`Local final tag ${state.tag} does not point to ${sha}.`, [
        ctx.resume("publish"),
      ]);
    }
  }
  await ctx.run("git", ["push", "origin", `refs/tags/${state.tag}`]);
}

async function candidateInputs(ctx: ReleaseContext): Promise<Map<string, string>> {
  const { state, options } = ctx;
  const candidateDir = state.publish.candidateDir ?? join(options.stateDir, "candidate");
  state.publish.candidateDir = candidateDir;
  ctx.save();
  const args = [
    "release:candidate",
    "--",
    "--tag",
    state.tag,
    "--target-sha",
    requireValue(state.cut.releaseSha, "release SHA"),
    "--npm-dist-tag",
    "latest",
    "--publication-route",
    "normal",
    "--release-profile",
    "beta",
    "--stable-soak-waiver",
    requireValue(state.validate.stableSoakWaiver, "stable soak waiver"),
    "--full-release-run",
    requireValue(state.validate.runId, "Full Release Validation run"),
    "--publish-workflow-ref",
    requireValue(state.validate.toolingTag, "tooling tag"),
    "--skip-dispatch",
    "--skip-parallels",
    "--skip-telegram",
    "--output-dir",
    candidateDir,
  ];
  if (state.validate.laneWaiver) {
    args.push("--lane-waiver", state.validate.laneWaiver);
  }
  if (options.pluginSdkApiAcknowledgement) {
    args.push("--plugin-sdk-api-acknowledgement", options.pluginSdkApiAcknowledgement);
  }
  const result = await ctx.run("pnpm", args, { allowFailure: true });
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    const digest =
      /(?:--plugin-sdk-api-acknowledgement\s+|Plugin SDK API[^\n]*?\b)([a-f0-9]{8})\b/iu.exec(
        output,
      )?.[1];
    throw new ReleaseRefusal(
      `Candidate validation failed:\n${output.trim().split("\n").slice(-20).join("\n")}`,
      [ctx.resume("publish", digest ? ["--plugin-sdk-api-acknowledgement", digest] : [])],
    );
  }
  const synthetic = {
    fullReleaseValidationRunAttempt: state.validate.runAttempt,
    publishCommand: buildReleasePublishDispatchCommand(
      {
        repo: state.repo,
        tag: state.tag,
        fullReleaseValidationRunId: requireValue(state.validate.runId, "validation run"),
        npmDistTag: "latest",
        pluginPublishScope: "all-publishable",
        workflowRef: requireValue(state.validate.toolingTag, "tooling tag"),
        stableSoakWaiver: state.validate.stableSoakWaiver,
        laneWaiver: state.validate.laneWaiver,
      },
      String(state.validate.runAttempt),
      requireValue(state.validate.toolingTag, "tooling tag"),
      "",
    ),
  };
  const evidence = options.dryRun
    ? synthetic
    : parseJson(
        readFileSync(join(candidateDir, "release-candidate-evidence.json"), "utf8"),
        "candidate evidence",
      );
  if (
    !isRecord(evidence) ||
    typeof evidence.publishCommand !== "string" ||
    !positiveInteger(evidence.fullReleaseValidationRunAttempt)
  ) {
    throw new Error("Candidate evidence has no publish command or validation attempt.");
  }
  state.validate.runAttempt = evidence.fullReleaseValidationRunAttempt;
  ctx.save();
  const inputs = parsePublishInputs(evidence.publishCommand);
  const expected = {
    tag: state.tag,
    full_release_validation_run_id: state.validate.runId,
    full_release_validation_run_attempt: String(evidence.fullReleaseValidationRunAttempt),
    npm_dist_tag: "latest",
    plugin_publish_scope: "all-publishable",
    publish_openclaw_npm: "true",
  };
  if (Object.entries(expected).some(([key, value]) => inputs.get(key) !== value)) {
    throw new ReleaseRefusal(
      "Candidate publication inputs do not match the selected stable release.",
      [ctx.resume("publish")],
    );
  }
  return inputs;
}

export async function publish(ctx: ReleaseContext): Promise<void> {
  const { state, options } = ctx;
  ctx.log("publish", "validating the candidate and preparing publication");
  const inputs = await candidateInputs(ctx);
  await ensureFinalTag(ctx);
  for (const lane of ["validate", "preflight"] as const) {
    const key = lane === "validate" ? "macosValidateRunId" : "macosPreflightRunId";
    if (state.publish[key]) {
      continue;
    }
    const dispatched = await dispatchReleaseWorkflow(ctx, {
      phase: "publish",
      workflow: lane === "validate" ? "openclaw-macos-validate.yml" : "openclaw-macos-publish.yml",
      repo: state.releasesRepo,
      ref: "main",
      inputs: [
        `tag=${state.tag}`,
        ...(lane === "preflight"
          ? [
              `source_ref=${state.branch}`,
              `public_release_branch=${state.branch}`,
              "preflight_only=true",
              "smoke_test_only=false",
              "allow_late_calver_recovery=false",
            ]
          : []),
      ],
    });
    state.publish[key] = dispatched.id;
    ctx.save();
  }
  if (!state.operator.publicationApproved) {
    ctx.log(
      "publish",
      `tag=${state.tag}\nrelease SHA=${state.cut.releaseSha}\ntooling tag=${state.validate.toolingTag}\nFRV=${state.validate.runId} attempt ${state.validate.runAttempt}\n${state.validate.stableSoakWaiver}\n${state.validate.laneWaiver || ""}\nDispatch inputs:\n${[...inputs].map(([key, value]) => `${key}=${value}`).join("\n")}`,
    );
    if (!options.approvePublication) {
      await confirmRelease(ctx, `Approve publication of ${state.tag}? [y/N]`, [
        ctx.resume("publish", ["--approve-publication"]),
      ]);
    }
    state.operator.publicationApproved = new Date().toISOString();
    ctx.save();
  }
  await probeCapabilities(ctx, requireValue(state.validate.toolingSha, "tooling SHA"));
  if (!state.publish.publishRunId) {
    if (!state.capabilities?.parentSweepsStaleChildren) {
      for (const command of manualSweepCommands(ctx)) {
        ctx.log("publish", command);
      }
    }
    inputs.set("wait_for_clawhub", "false");
    const dispatched = await dispatchReleaseWorkflow(ctx, {
      phase: "publish",
      workflow: "openclaw-release-publish.yml",
      repo: state.repo,
      ref: requireValue(state.validate.toolingTag, "tooling tag"),
      inputs: [...inputs].map(([key, value]) => `${key}=${value}`),
    });
    state.publish.publishRunId = dispatched.id;
    state.publish.dispatchedAt = dispatched.dispatchedAt;
    ctx.save();
  }
  const id = state.publish.publishRunId;
  const next = [
    ...manualSweepCommands(ctx),
    shellCommand("pnpm", [
      "release:publish-preflight",
      "--tag",
      state.tag,
      "--full-release-validation-run-id",
      requireValue(state.validate.runId, "validation run"),
      "--full-release-validation-run-attempt",
      String(state.validate.runAttempt),
      "--npm-dist-tag",
      "latest",
      "--workflow-ref",
      requireValue(state.validate.toolingTag, "tooling tag"),
    ]),
    ctx.resume("publish"),
  ];
  const reportedChildren = new Set<string>();
  await pollRelease(ctx, {
    label: `npm visibility of openclaw@${state.release}`,
    timeoutMs: 2 * HOUR,
    next,
    probe: async () => {
      await approveReleaseGates(ctx, state.repo, id, "npm-release");
      if (!state.capabilities?.parentApprovalReceipt) {
        await reportWaitingChildren(ctx, reportedChildren);
      }
      const npm = await ctx.run(
        "npm",
        ["view", `openclaw@${state.release}`, "version", "--json", "--prefer-online"],
        { allowFailure: true, dryRunStdout: JSON.stringify(state.release) },
      );
      if (npm.exitCode === 0 && parseJson(npm.stdout, "npm version") === state.release) {
        state.publish.npmVisibleAt = new Date().toISOString();
        ctx.save();
        return true;
      }
      const parent = await readReleaseRun(ctx, state.repo, id);
      if (parent.conclusion === "failure" || parent.conclusion === "cancelled") {
        throw new ReleaseRefusal(
          `Publish parent ${id} ${parent.conclusion} before core npm became visible.`,
          next,
        );
      }
      return undefined;
    },
  });
}
