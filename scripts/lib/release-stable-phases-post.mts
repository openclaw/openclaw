import { isRecord } from "./record-shared.mjs";
import { fetchReleaseMain } from "./release-stable-phases.mts";
import {
  pollRelease,
  probeCapabilities,
  ReleaseRefusal,
  shellCommand,
  type ReleaseContext,
  type ReleasePhase,
} from "./release-stable-state.mts";
import {
  approveReleaseGates,
  dispatchReleaseWorkflow,
  parseJson,
  readReleaseRun,
} from "./release-stable-workflows.mts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}; complete the preceding release phase.`);
  }
  return value;
}

async function ensureCapabilities(ctx: ReleaseContext): Promise<void> {
  await probeCapabilities(ctx, required(ctx.state.validate.toolingSha, "tooling SHA"));
}

async function betaSynced(ctx: ReleaseContext, syncedPlaceholder: boolean): Promise<boolean> {
  const result = await ctx.run("npm", ["view", "openclaw", "dist-tags", "--json"], {
    dryRunStdout: JSON.stringify({ beta: syncedPlaceholder ? ctx.state.release : "previous-beta" }),
  });
  const tags = parseJson(result.stdout, "npm dist-tags");
  if (!isRecord(tags)) {
    throw new Error("Invalid npm dist-tags response.");
  }
  return tags.beta === ctx.state.release;
}

export async function syncBeta(ctx: ReleaseContext): Promise<void> {
  const { state } = ctx;
  ctx.log("sync-beta", "verifying the beta dist-tag points to the published stable release");
  if (state.phases.publish.status !== "completed") {
    throw new ReleaseRefusal("Core npm publication must complete before syncing beta.", [
      ctx.resume("publish"),
    ]);
  }
  if (!(await betaSynced(ctx, false))) {
    await ensureCapabilities(ctx);
    let synced = false;
    if (state.capabilities?.parentSyncsBetaDistTag && !state.syncBeta.runId) {
      const label = "publish parent beta dist-tag sync";
      try {
        await pollRelease(ctx, {
          label,
          timeoutMs: 20 * MINUTE,
          probe: async () => ((await betaSynced(ctx, true)) ? true : undefined),
        });
        synced = true;
      } catch (error) {
        if (
          !(error instanceof ReleaseRefusal) ||
          error.message !== `Timed out waiting for ${label}`
        ) {
          throw error;
        }
        ctx.log("sync-beta", "parent sync timed out; dispatching the dist-tag workflow");
      }
    }
    if (!synced) {
      if (!state.syncBeta.runId) {
        const dispatched = await dispatchReleaseWorkflow(ctx, {
          phase: "sync-beta",
          workflow: "openclaw-npm-dist-tags.yml",
          repo: state.releasesRepo,
          ref: "main",
          inputs: ["mode=sync_beta_to_stable", `tag=${state.tag}`],
        });
        state.syncBeta.runId = dispatched.id;
        ctx.save();
      }
      await pollRelease(ctx, {
        label: "beta dist-tag sync",
        timeoutMs: 20 * MINUTE,
        next: [
          shellCommand("gh", ["run", "view", state.syncBeta.runId, "--repo", state.releasesRepo]),
          ctx.resume("sync-beta"),
        ],
        probe: async () => ((await betaSynced(ctx, true)) ? true : undefined),
      });
    }
  }
  state.syncBeta.verifiedAt = new Date().toISOString();
  ctx.save();
}

async function readGithubRelease(ctx: ReleaseContext, draftPlaceholder = false) {
  const result = await ctx.run(
    "gh",
    ["release", "view", ctx.state.tag, "--repo", ctx.state.repo, "--json", "isDraft,tagName"],
    {
      allowFailure: true,
      dryRunStdout: JSON.stringify({
        isDraft: draftPlaceholder,
        tagName: ctx.state.tag,
      }),
    },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const release = parseJson(result.stdout, "GitHub release");
  if (
    !isRecord(release) ||
    typeof release.isDraft !== "boolean" ||
    release.tagName !== ctx.state.tag
  ) {
    throw new Error(`Invalid GitHub release response for ${ctx.state.tag}.`);
  }
  return release;
}

export async function flipGithub(ctx: ReleaseContext): Promise<void> {
  const { state } = ctx;
  ctx.log("flip-github", "waiting for the release and making it public");
  const next = [
    shellCommand("gh", ["release", "view", state.tag, "--repo", state.repo]),
    ctx.resume("flip-github"),
  ];
  const release = await pollRelease(ctx, {
    label: `GitHub release ${state.tag}`,
    timeoutMs: 10 * MINUTE,
    next,
    probe: () => readGithubRelease(ctx, true),
  });
  if (release.isDraft) {
    await ctx.run("gh", [
      "release",
      "edit",
      state.tag,
      "--repo",
      state.repo,
      "--draft=false",
      "--latest",
    ]);
    state.flipGithub.flippedBy = "orchestrator";
    ctx.save();
  } else {
    state.flipGithub.flippedBy ??= "parent";
  }
  const verified = await readGithubRelease(ctx);
  if (!verified || verified.isDraft) {
    throw new ReleaseRefusal(`GitHub release ${state.tag} is still missing or draft.`, next);
  }
  state.flipGithub.verifiedAt = new Date().toISOString();
  ctx.save();
}

async function waitForRun(
  ctx: ReleaseContext,
  repo: string,
  id: string,
  phase: ReleasePhase,
  timeoutMs: number,
  approveMac = false,
) {
  return pollRelease(ctx, {
    label: `${phase} run ${id}`,
    timeoutMs,
    next: [shellCommand("gh", ["run", "view", id, "--repo", repo]), ctx.resume(phase)],
    probe: async () => {
      if (approveMac) {
        await approveReleaseGates(ctx, repo, id, "mac-release");
      }
      const run = await readReleaseRun(ctx, repo, id);
      return run.status === "completed" ? run : undefined;
    },
  });
}

function macosInputs(ctx: ReleaseContext, preflight: boolean): string[] {
  return [
    `tag=${ctx.state.tag}`,
    `source_ref=${ctx.state.branch}`,
    `public_release_branch=${ctx.state.branch}`,
    `preflight_only=${preflight}`,
    "smoke_test_only=false",
    "allow_late_calver_recovery=false",
  ];
}

function workflowCommand(repo: string, workflow: string, inputs: string[]): string {
  return shellCommand("gh", [
    "workflow",
    "run",
    workflow,
    "--repo",
    repo,
    "--ref",
    "main",
    ...inputs.flatMap((input) => ["-f", input]),
  ]);
}

export async function macos(ctx: ReleaseContext): Promise<void> {
  const { state } = ctx;
  ctx.log("macos", "checking update compatibility before completing the macOS lanes");
  await fetchReleaseMain(ctx);
  const inventory = await ctx.run(
    "git",
    ["show", "origin/main:scripts/lib/update-compat-inventory.json"],
    {
      allowFailure: true,
      dryRunStdout: JSON.stringify({ releases: [{ version: state.release }] }),
    },
  );
  if (inventory.exitCode !== 0 || !inventory.stdout.includes(JSON.stringify(state.release))) {
    const integrity = await ctx.run("npm", ["view", `openclaw@${state.release}`, "dist.integrity"]);
    throw new ReleaseRefusal(
      `Update compatibility inventory on main is missing ${state.release}.`,
      [
        shellCommand("pnpm", [
          "update:compat:gen",
          "--release",
          `<unpacked-dir>=${integrity.stdout.trim()}`,
        ]),
        shellCommand("git", ["add", "scripts/lib/update-compat-inventory.json"]),
        shellCommand("git", [
          "commit",
          "-m",
          `fix(release): record the ${state.release} npm release in the update compatibility inventory`,
        ]),
        `# Open and land the update compatibility inventory PR on main.`,
        ctx.resume("macos"),
      ],
    );
  }
  state.macos.validateRunId ??= state.publish.macosValidateRunId;
  state.macos.preflightRunId ??= state.publish.macosPreflightRunId;
  const validateId = required(state.macos.validateRunId, "macOS validate run");
  const preflightId = required(state.macos.preflightRunId, "macOS preflight run");
  ctx.save();
  const validation = await waitForRun(ctx, state.releasesRepo, validateId, "macos", 3 * HOUR, true);
  if (validation.conclusion !== "success") {
    throw new ReleaseRefusal(
      `macOS validate run ${validateId} concluded ${String(validation.conclusion)}.`,
      [
        workflowCommand(state.releasesRepo, "openclaw-macos-validate.yml", [`tag=${state.tag}`]),
        "# Resolve the new validate run ID and supply it on resume.",
        ctx.resume("macos", ["--macos-validate-run-id", "<new-run-id>"]),
      ],
    );
  }
  const preflight = await waitForRun(ctx, state.releasesRepo, preflightId, "macos", 3 * HOUR, true);
  if (preflight.conclusion !== "success") {
    throw new ReleaseRefusal(
      `macOS preflight run ${preflightId} concluded ${String(preflight.conclusion)}.`,
      [
        workflowCommand(state.releasesRepo, "openclaw-macos-publish.yml", [
          ...macosInputs(ctx, true),
          `resume_notarization_run_id=${preflightId}`,
          `resume_notarization_run_attempt=${String(preflight.run_attempt)}`,
          "resume_notarization_variant=all",
        ]),
        "# Resolve the new preflight run ID and supply it on resume.",
        ctx.resume("macos", ["--macos-preflight-run-id", "<new-run-id>"]),
      ],
    );
  }
  if (!state.macos.publishRunId) {
    const release = await readGithubRelease(ctx);
    if (!release || release.isDraft) {
      throw new ReleaseRefusal("The GitHub release must be public before macOS publication.", [
        ctx.resume("flip-github"),
      ]);
    }
    const dispatched = await dispatchReleaseWorkflow(ctx, {
      phase: "macos",
      workflow: "openclaw-macos-publish.yml",
      repo: state.releasesRepo,
      ref: "main",
      inputs: [
        ...macosInputs(ctx, false),
        `preflight_run_id=${preflightId}`,
        `validate_run_id=${validateId}`,
      ],
      excludeRunIds: [
        preflightId,
        ...[state.publish.macosPreflightRunId].filter((id) => id !== undefined),
      ],
    });
    state.macos.publishRunId = dispatched.id;
    ctx.save();
  }
  const published = await waitForRun(
    ctx,
    state.releasesRepo,
    state.macos.publishRunId,
    "macos",
    2 * HOUR,
    true,
  );
  if (published.conclusion !== "success") {
    throw new ReleaseRefusal(
      `macOS publish run ${state.macos.publishRunId} concluded ${String(published.conclusion)}.`,
      [
        shellCommand("gh", [
          "run",
          "view",
          state.macos.publishRunId,
          "--repo",
          state.releasesRepo,
          "--log-failed",
        ]),
        ctx.resume("macos"),
      ],
    );
  }
  await fetchReleaseMain(ctx);
  const appcast = await ctx.run("git", ["show", "origin/main:appcast.xml"], {
    allowFailure: true,
    dryRunStdout: `<sparkle:shortVersionString>${state.release}</sparkle:shortVersionString>`,
  });
  const versions = appcast.stdout.match(/\b\d{4}\.\d{1,2}\.\d+(?:-[a-z0-9.]+)?\b/gu) ?? [];
  if (appcast.exitCode !== 0 || !versions.some((version) => version === state.release)) {
    const prs = await ctx.run("gh", [
      "pr",
      "list",
      "--repo",
      state.repo,
      "--search",
      `chore(release): update appcast for ${state.release} in:title`,
      "--state",
      "open",
      "--json",
      "number,url",
    ]);
    const rows = parseJson(prs.stdout, "appcast PRs");
    const urls = Array.isArray(rows)
      ? rows.filter(isRecord).flatMap((row) => (typeof row.url === "string" ? [row.url] : []))
      : [];
    throw new ReleaseRefusal(`The ${state.release} appcast entry is not on main.`, [
      ...urls.map((url) => `# Merge appcast PR ${url}`),
      ...(urls.length
        ? []
        : [`# Locate and land chore(release): update appcast for ${state.release}.`]),
      ctx.resume("macos"),
    ]);
  }
  state.macos.appcastVerifiedAt = new Date().toISOString();
  ctx.save();
}

function closeoutMainRecovery(ctx: ReleaseContext): string[] {
  const { state } = ctx;
  const title = `chore(release): close out ${state.release} on main`;
  const files = [`CHANGELOG/${state.release}.md`, `CHANGELOG/records/${state.release}.md`];
  return [
    shellCommand("git", ["switch", "-c", `${state.branch}-main-closeout`, "origin/main"]),
    shellCommand("pnpm", ["release:prepare", "--", "--version", state.release, "--write"]),
    ...files.map((file) => `git show ${state.tag}:${file} > ${file}`),
    "pnpm release:prep",
    "pnpm changelog:check",
    "pnpm release:generated:check",
    "pnpm deps:npm-lock:check",
    `# Review and commit the generated release files; open and land a PR titled ${title}.`,
    ctx.resume("closeout"),
  ];
}

async function closeoutAssetsPresent(ctx: ReleaseContext): Promise<boolean> {
  const asset = `openclaw-${ctx.state.release}-stable-main-closeout.json`;
  const expected = [asset, `${asset}.sha256`];
  const result = await ctx.run(
    "gh",
    [
      "release",
      "view",
      ctx.state.tag,
      "--repo",
      ctx.state.repo,
      "--json",
      "assets",
      "--jq",
      "[.assets[].name]",
    ],
    { dryRunStdout: JSON.stringify(expected) },
  );
  const assets = parseJson(result.stdout, "closeout release assets");
  if (!Array.isArray(assets) || !assets.every((name) => typeof name === "string")) {
    throw new Error("Invalid closeout release assets response.");
  }
  return expected.every((name) => assets.includes(name));
}

export async function closeout(ctx: ReleaseContext): Promise<void> {
  const { state } = ctx;
  ctx.log("closeout", "waiting for the publish parent and checking the shipped state on main");
  const publishId = required(state.publish.publishRunId, "publish parent run");
  const parent = await waitForRun(ctx, state.repo, publishId, "closeout", 3 * HOUR);
  state.closeout.publishRunConclusion = String(parent.conclusion);
  ctx.save();
  if (parent.conclusion !== "success") {
    throw new ReleaseRefusal(
      `Publish parent ${publishId} concluded ${String(parent.conclusion)}.`,
      [
        shellCommand("gh", ["run", "view", publishId, "--repo", state.repo, "--log-failed"]),
        "# allow_failed_publish_recovery=true requires verified npm + Docker publication; follow Stable main closeout in docs/reference/RELEASING.md.",
        ctx.resume("closeout"),
      ],
    );
  }
  await fetchReleaseMain(ctx);
  const pkg = await ctx.run("git", ["show", "origin/main:package.json"], {
    allowFailure: true,
    dryRunStdout: JSON.stringify({ version: state.release }),
  });
  const notesPath = `CHANGELOG/${state.release}.md`;
  const mainNotes = await ctx.run("git", ["show", `origin/main:${notesPath}`], {
    allowFailure: true,
    dryRunStdout: `## ${state.release}\n`,
  });
  const tagNotes = await ctx.run("git", ["show", `${state.tag}:${notesPath}`], {
    allowFailure: true,
    dryRunStdout: `## ${state.release}\n`,
  });
  const manifest = pkg.exitCode === 0 ? parseJson(pkg.stdout, "main package.json") : undefined;
  if (
    !isRecord(manifest) ||
    manifest.version !== state.release ||
    mainNotes.exitCode !== 0 ||
    tagNotes.exitCode !== 0 ||
    mainNotes.stdout !== tagNotes.stdout
  ) {
    throw new ReleaseRefusal(
      "Main does not carry the shipped version and exact changelog.",
      closeoutMainRecovery(ctx),
    );
  }
  if (await closeoutAssetsPresent(ctx)) {
    state.closeout.verifiedAt = new Date().toISOString();
    ctx.save();
    return;
  }
  if (!state.closeout.runId) {
    await ensureCapabilities(ctx);
    const inputs = [`tag=${state.tag}`];
    if (!state.capabilities?.closeoutResolvesWaivers) {
      inputs.push(
        `stable_soak_waiver=${required(state.validate.stableSoakWaiver, "stable soak waiver")}`,
      );
      if (state.validate.laneWaiver) {
        inputs.push(`lane_waiver=${state.validate.laneWaiver}`);
      }
    }
    const dispatched = await dispatchReleaseWorkflow(ctx, {
      phase: "closeout",
      workflow: "openclaw-stable-main-closeout.yml",
      repo: state.repo,
      ref: "main",
      inputs,
    });
    state.closeout.runId = dispatched.id;
    ctx.save();
  }
  const run = await waitForRun(ctx, state.repo, state.closeout.runId, "closeout", HOUR);
  if (run.conclusion !== "success" || !(await closeoutAssetsPresent(ctx))) {
    throw new ReleaseRefusal(
      run.conclusion !== "success"
        ? `Closeout run ${state.closeout.runId} concluded ${String(run.conclusion)}.`
        : `Closeout run ${state.closeout.runId} succeeded but required release assets are missing.`,
      [
        shellCommand("gh", [
          "run",
          "view",
          state.closeout.runId,
          "--repo",
          state.repo,
          "--log-failed",
        ]),
        ctx.resume("closeout"),
      ],
    );
  }
  state.closeout.verifiedAt = new Date().toISOString();
  ctx.save();
}
