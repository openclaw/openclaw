#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { closeout, flipGithub, macos, syncBeta } from "./lib/release-stable-phases-post.mts";
import { cut, publish, validate } from "./lib/release-stable-phases.mts";
import {
  RELEASE_PHASES,
  ReleaseRefusal,
  acquireReleaseLock,
  createReleaseRunner,
  isReleasePhase,
  loadReleaseState,
  resetReleasePhases,
  resumeCommand,
  saveReleaseState,
  shellCommand,
  type ReleaseContext,
  type ReleaseOptions,
  type ReleasePhase,
  type ReleaseRunner,
  type ReleaseState,
} from "./lib/release-stable-state.mts";

export function parseReleaseStableArgs(argv: string[]): ReleaseOptions | undefined {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      from: { type: "string" },
      "dry-run": { type: "boolean" },
      status: { type: "boolean" },
      help: { type: "boolean" },
      repo: { type: "string" },
      "releases-repo": { type: "string" },
      "state-dir": { type: "string" },
      operator: { type: "string" },
      "cut-sha": { type: "string" },
      "confirm-cut-sha": { type: "string" },
      "approve-publication": { type: "boolean" },
      "tooling-sha": { type: "string" },
      "stable-soak-waiver": { type: "string" },
      "lane-waiver": { type: "string" },
      "plugin-sdk-api-acknowledgement": { type: "string" },
      "macos-preflight-run-id": { type: "string" },
      "macos-validate-run-id": { type: "string" },
    },
  });
  if (values.help) {
    console.log(`Usage: pnpm release:stable <version> [options]
  --from <${RELEASE_PHASES.join("|")}>  Resume from this phase
  --dry-run                          Print commands without executing or saving state
  --status                           Print retained phase state
  --repo <owner/repo>                 Default: openclaw/openclaw
  --releases-repo <owner/repo>         Default: openclaw/releases
  --state-dir <directory>             Default: .artifacts/release-<version>
  --operator <name>                   Name recorded for approvals and waivers
  --cut-sha <sha>                     Select the release cut
  --confirm-cut-sha <sha>             Confirm that exact cut without a TTY
  --approve-publication              Approve publication without a TTY
  --tooling-sha <sha>                 Select protected main tooling
  --stable-soak-waiver <reason>       Override the standard waiver
  --lane-waiver <reason>              Acknowledge deferred lanes
  --plugin-sdk-api-acknowledgement <8hex>
  --macos-preflight-run-id <id>        Seed recovery with --from macos
  --macos-validate-run-id <id>         Seed recovery with --from macos`);
    return undefined;
  }
  const release = positionals[0];
  if (positionals.length !== 1 || !release || !/^\d{4}\.\d{1,2}\.\d+$/u.test(release)) {
    throw new ReleaseRefusal("Expected one final stable version (YYYY.M.PATCH)", [
      "pnpm release:stable <version>",
    ]);
  }
  const from = values.from;
  if (from !== undefined && !isReleasePhase(from)) {
    throw new ReleaseRefusal(`Unknown phase ${from}`, [`pnpm release:stable ${release}`]);
  }
  for (const key of ["cut-sha", "confirm-cut-sha", "tooling-sha"] as const) {
    if (values[key] !== undefined && !/^[a-f0-9]{40}$/u.test(values[key])) {
      throw new ReleaseRefusal(`--${key} requires a full lowercase commit SHA`, [
        `pnpm release:stable ${release}`,
      ]);
    }
  }
  for (const key of ["repo", "releases-repo"] as const) {
    if (values[key] !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(values[key])) {
      throw new ReleaseRefusal(`--${key} must be owner/name`, [`pnpm release:stable ${release}`]);
    }
  }
  for (const key of ["macos-preflight-run-id", "macos-validate-run-id"] as const) {
    if (values[key] !== undefined && (!/^[1-9][0-9]*$/u.test(values[key]) || from !== "macos")) {
      throw new ReleaseRefusal(`--${key} requires a positive run ID and --from macos`, [
        `pnpm release:stable ${release} --from macos`,
      ]);
    }
  }
  const acknowledgement = values["plugin-sdk-api-acknowledgement"];
  if (acknowledgement !== undefined && !/^[a-f0-9]{8}$/u.test(acknowledgement)) {
    throw new ReleaseRefusal("Plugin SDK API acknowledgement must be 8 lowercase hex digits", [
      `pnpm release:stable ${release}`,
    ]);
  }
  return {
    release,
    from,
    dryRun: values["dry-run"] ?? false,
    status: values.status ?? false,
    approvePublication: values["approve-publication"] ?? false,
    repo: values.repo ?? "openclaw/openclaw",
    releasesRepo: values["releases-repo"] ?? "openclaw/releases",
    stateDir: values["state-dir"] ?? `.artifacts/release-${release}`,
    operator: values.operator ?? process.env.USER ?? "operator",
    cutSha: values["cut-sha"],
    confirmCutSha: values["confirm-cut-sha"],
    toolingSha: values["tooling-sha"],
    stableSoakWaiver: values["stable-soak-waiver"],
    laneWaiver: values["lane-waiver"],
    pluginSdkApiAcknowledgement: acknowledgement,
    macosPreflightRunId: values["macos-preflight-run-id"],
    macosValidateRunId: values["macos-validate-run-id"],
  };
}

export function printReleaseStatus(state: ReleaseState): void {
  const data = {
    cut: state.cut,
    validate: state.validate,
    publish: state.publish,
    "sync-beta": state.syncBeta,
    "flip-github": state.flipGithub,
    macos: state.macos,
    closeout: state.closeout,
  };
  for (const phase of RELEASE_PHASES) {
    const details = Object.entries(data[phase])
      .filter(([key, value]) => /(?:Sha|Tag|Id|Attempt|At|By)$/u.test(key) && value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    console.log(
      `${phase.padEnd(12)} ${state.phases[phase].status.padEnd(10)} ${details}`.trimEnd(),
    );
  }
}

export async function runReleaseStable(
  options: ReleaseOptions,
  runner?: ReleaseRunner,
): Promise<void> {
  let releaseLock: (() => void) | undefined;
  if (!options.status && !options.dryRun) {
    try {
      releaseLock = acquireReleaseLock(options.stateDir);
    } catch (error) {
      if (error instanceof ReleaseRefusal) {
        error.next.push(resumeCommand(options, options.from));
      }
      throw error;
    }
  }
  try {
    const state = loadReleaseState(options);
    if (options.status) {
      printReleaseStatus(state);
      return;
    }
    if (options.cutSha && state.cut.cutSha && options.cutSha !== state.cut.cutSha) {
      throw new ReleaseRefusal(
        `This state belongs to cut ${state.cut.cutSha}. Use a fresh state directory for the explicitly selected cut ${options.cutSha} so retained validation and candidate artifacts cannot be reused.`,
        [
          resumeCommand(options, "cut", [
            "--state-dir",
            `${options.stateDir}-cut-${options.cutSha.slice(0, 12)}`,
          ]),
        ],
      );
    }
    if (options.from) {
      resetReleasePhases(state, options.from);
    }
    if (options.macosPreflightRunId) {
      state.macos.preflightRunId = options.macosPreflightRunId;
    }
    if (options.macosValidateRunId) {
      state.macos.validateRunId = options.macosValidateRunId;
    }
    const ctx: ReleaseContext = {
      options,
      state,
      run: createReleaseRunner(options.dryRun, runner),
      save: () => saveReleaseState(options, state),
      log: (phase, message) => console.log(`[release-stable] ${phase}: ${message}`),
      resume: (phase, extra) => resumeCommand(options, phase, extra),
    };
    ctx.save();
    const handlers: Record<ReleasePhase, (context: ReleaseContext) => Promise<void>> = {
      cut,
      validate,
      publish,
      "sync-beta": syncBeta,
      "flip-github": flipGithub,
      macos,
      closeout,
    };
    for (const phase of RELEASE_PHASES) {
      if (state.phases[phase].status === "completed") {
        continue;
      }
      const handler = handlers[phase];
      state.phases[phase] = {
        status: "running",
        startedAt: state.phases[phase].startedAt ?? new Date().toISOString(),
      };
      ctx.save();
      ctx.log(phase, "starting");
      try {
        await handler(ctx);
        state.phases[phase].status = "completed";
        state.phases[phase].completedAt = new Date().toISOString();
        ctx.save();
        ctx.log(phase, "completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.phases[phase].status = "refused";
        state.phases[phase].error = message;
        ctx.save();
        throw error instanceof ReleaseRefusal ? error : new ReleaseRefusal(message, [ctx.resume()]);
      }
    }
    printReleaseStatus(state);
    console.log(`Release: https://github.com/${state.repo}/releases/tag/${state.tag}`);
    const runs = [
      ["Full Release Validation", state.repo, state.validate.runId],
      ["Publish parent", state.repo, state.publish.publishRunId],
      ["Beta sync", state.releasesRepo, state.syncBeta.runId],
      ["Initial macOS validate", state.releasesRepo, state.publish.macosValidateRunId],
      ["Initial macOS preflight", state.releasesRepo, state.publish.macosPreflightRunId],
      ["macOS validate", state.releasesRepo, state.macos.validateRunId],
      ["macOS preflight", state.releasesRepo, state.macos.preflightRunId],
      ["macOS publish", state.releasesRepo, state.macos.publishRunId],
      ["Closeout", state.repo, state.closeout.runId],
    ];
    for (const [name, repo, id] of runs) {
      if (id) {
        console.log(`${name}: https://github.com/${repo}/actions/runs/${id}`);
      }
    }
    console.log("Cleanup reminders (run after reviewing the completed release):");
    if (state.validate.laneWaiver) {
      console.log(
        shellCommand("gh", [
          "variable",
          "delete",
          "OPENCLAW_FRV_LANE_WAIVER",
          "--repo",
          state.repo,
        ]),
      );
    }
    console.log(
      "# Switch away from the local cut branches, then delete them when no longer needed:",
    );
    console.log(
      shellCommand("git", ["branch", "-d", state.branch, `${state.branch}-main-closeout`]),
    );
  } finally {
    releaseLock?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseReleaseStableArgs(process.argv.slice(2));
    if (options) {
      await runReleaseStable(options);
    }
  } catch (error) {
    console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Next:");
    const next =
      error instanceof ReleaseRefusal ? error.next : ["pnpm release:stable <version> --help"];
    for (const command of next) {
      console.error(command);
    }
    process.exitCode = 2;
  }
}
