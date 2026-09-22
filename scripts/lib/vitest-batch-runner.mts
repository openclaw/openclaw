// Runs grouped batches through the repository's installed Vitest entrypoint.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertTestHomeSelection, type TestHomeSelection } from "../../test/test-home-policy.mts";
import { installVitestProcessGroupCleanup } from "../vitest-process-group.mts";
import { resolveVitestCliEntry } from "./vitest-build-prerequisites.mts";
import { resolveExplicitVitestMode } from "./vitest-cli-mode.mts";
import { resolveVitestHomeSelection } from "./vitest-home-selection.mts";
import { resolveVitestNodeArgs } from "./vitest-process-env.mts";
import { exitVitestBySignal, spawnOwnedVitestProcess } from "./vitest-process.mts";
import type { VitestReportOutcome } from "./vitest-report-owner.mts";
import { createVitestWorkerRun } from "./vitest-worker-run.mts";

export type VitestBatchRunParams = {
  args: string[];
  config: string;
  env?: NodeJS.ProcessEnv;
  // Owner-generated report configs retain their validated original selection.
  homeMode?: TestHomeSelection;
  targets: string[];
  onComplete?: (outcome: VitestReportOutcome) => void;
};

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, "../..");

/**
 * Runs one Vitest batch and forwards process-group cleanup signals.
 */
export async function runVitestBatch(params: VitestBatchRunParams): Promise<number> {
  const env = params.env ?? process.env;
  const homeMode =
    params.homeMode ??
    resolveVitestHomeSelection(["--config", params.config, ...params.args, ...params.targets], {
      cwd: repoRoot,
      env,
    });
  assertTestHomeSelection(env, homeMode);
  const workers =
    resolveExplicitVitestMode(["run", ...params.args]) === "watch"
      ? undefined
      : createVitestWorkerRun(env);
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
  };
  // Artifact verification can outlive the child's signal handlers.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let outcome: VitestReportOutcome;
  try {
    // Match project runs: native workers borrow this invocation's prepared source,
    // rather than compiling the application independently inside every worker.
    const { child, completion } = spawnOwnedVitestProcess({
      homeMode,
      command: process.execPath,
      args: [
        ...resolveVitestNodeArgs(env),
        ...(workers
          ? [
              path.join(repoRoot, "scripts/lib/vitest-worker-bootstrap.mts"),
              workers.descriptor.directory,
            ]
          : []),
        resolveVitestCliEntry({ env }),
        "run",
        "--config",
        params.config,
        ...params.args,
        ...params.targets,
      ],
      options: {
        cwd: repoRoot,
        env,
        stdio: workers ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
      },
    });
    const cleanup = installVitestProcessGroupCleanup({
      child,
      forceSignal: "SIGKILL",
      forceSignalDelayMs: 100,
    });
    try {
      const { code, signal } = await (workers ? workers.borrow(child, completion) : completion);
      interrupted ??= cleanup.getForwardedSignal() ?? signal ?? undefined;
      outcome = { code: code ?? 1, signal: interrupted ?? null };
    } finally {
      cleanup.teardown();
    }
  } finally {
    try {
      await workers?.dispose();
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (interrupted && !params.onComplete) {
        await exitVitestBySignal(interrupted);
      }
    }
  }
  outcome.signal = interrupted ?? outcome.signal;
  params.onComplete?.(outcome);
  return outcome.code;
}

/**
 * Checks whether a module URL is the current direct script entrypoint.
 */
export function isDirectScriptRun(metaUrl: string): boolean {
  const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return metaUrl === entryHref;
}
