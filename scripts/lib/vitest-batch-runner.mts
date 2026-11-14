// Runs grouped batches through the repository's installed Vitest entrypoint.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestHomeSelection, type TestHomeSelection } from "../../test/test-home-policy.mts";
import { installVitestProcessGroupCleanup } from "../vitest-process-group.mts";
import { signalExitCode } from "./managed-child-process.mts";
import { resolveVitestCliEntry } from "./vitest-build-prerequisites.mts";
import { resolveExplicitVitestMode } from "./vitest-cli-mode.mts";
import { resolveVitestHomeSelection } from "./vitest-home-selection.mts";
import {
  VITEST_INFRASTRUCTURE_EXIT_CODE,
  vitestInfrastructureExitCode,
} from "./vitest-outcome.mts";
import { resolveVitestNodeArgs } from "./vitest-process-env.mts";
import { exitVitestBySignal, spawnOwnedVitestProcess } from "./vitest-process.mts";
import type { VitestReportOutcome } from "./vitest-report-owner.mts";
import { resolveVitestTestCommand } from "./vitest-test-runtime.mts";
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
  const testCommand = resolveVitestTestCommand(
    [
      ...resolveVitestNodeArgs(env),
      resolveVitestCliEntry({ env }),
      "run",
      "--config",
      params.config,
      ...params.args,
      ...params.targets,
    ],
    env,
  );
  const workers =
    resolveExplicitVitestMode(["run", ...params.args]) === "watch"
      ? undefined
      : createVitestWorkerRun(env);
  if (workers) {
    const cliIndex = testCommand.args.findIndex((arg) => path.basename(arg) === "vitest.mjs");
    testCommand.args.splice(
      cliIndex,
      0,
      path.join(repoRoot, "scripts/lib/vitest-worker-bootstrap.mts"),
      workers.descriptor.directory,
    );
  }
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
  };
  // Artifact verification can outlive the child's signal handlers.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let outcome: VitestReportOutcome = { code: VITEST_INFRASTRUCTURE_EXIT_CODE, signal: null };
  try {
    // Match project runs: native workers borrow this invocation's prepared source,
    // rather than compiling the application independently inside every worker.
    const { child, completion } = spawnOwnedVitestProcess({
      homeMode,
      ...testCommand,
      options: {
        cwd: repoRoot,
        env: testCommand.envOverrides ? { ...env, ...testCommand.envOverrides } : env,
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
      outcome = {
        code: interrupted ? signalExitCode(interrupted) : (code ?? VITEST_INFRASTRUCTURE_EXIT_CODE),
        signal: interrupted ?? null,
      };
    } finally {
      cleanup.teardown();
    }
  } catch (error) {
    console.error(error);
    outcome.code = vitestInfrastructureExitCode(outcome.code);
  } finally {
    try {
      await workers?.dispose({ interrupted: Boolean(interrupted) }).catch((error: unknown) => {
        console.error(error);
        outcome.code = vitestInfrastructureExitCode(outcome.code);
      });
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
