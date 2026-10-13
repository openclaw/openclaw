import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import {
  crabboxCommandOutput,
  leaseRunArgs,
  runCrabboxCommand,
  type CrabboxCommandRunner,
} from "./crabbox-worker-command.js";
import { createCrabboxNodeRuntimeSetup } from "./crabbox-worker-node-enrollment.js";
import { runProvisionSetup } from "./crabbox-worker-provision-commands.js";
import {
  resolveCrabboxNodeEnrollmentTimeoutMs,
  WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";
import type { RecipePreparation } from "./crabbox-worker-warm-image-recipe.js";

type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;

export async function prepareCrabboxWorkerRuntime(params: {
  context: Omit<Parameters<typeof runProvisionSetup>[0], "phase" | "setup">;
  prepareNodeRuntime: NonNullable<Parameters<WorkerProvider["provision"]>[2]>["prepareNodeRuntime"];
  leaseId: string;
  scrubScript?: string;
  preparationSignal?: AbortSignal;
  assertCurrent: () => void;
  onSetupFailure: () => void;
}) {
  if (!params.prepareNodeRuntime) {
    throw new Error("Crabbox project snapshots require node runtime preparation");
  }
  const runtime = await params.prepareNodeRuntime();
  params.context.signal?.throwIfAborted();
  params.assertCurrent();
  const setup = createCrabboxNodeRuntimeSetup({
    nodeBootstrap: runtime.nodeBootstrap,
    workerBundle: runtime.workerBundle,
    leaseId: params.leaseId,
    target: params.context.profile.target,
  });
  try {
    await runProvisionSetup({
      ...params.context,
      phase: "node runtime preparation",
      // Node clears its own environment; scrub must also inherit no shell credentials.
      setup: params.scrubScript
        ? `${setup.command}\nunset ${Object.keys(setup.forwardedEnv).join(" ")}\n${params.scrubScript}`
        : setup.command,
      forwardedEnv: setup.forwardedEnv,
      timeoutMs:
        resolveCrabboxNodeEnrollmentTimeoutMs(runtime.bootstrapTimeoutMs) +
        (params.scrubScript ? WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS : 0),
      signal:
        runtime.signal && params.preparationSignal
          ? AbortSignal.any([params.preparationSignal, runtime.signal])
          : (params.preparationSignal ?? runtime.signal),
    });
  } catch (error) {
    // The command owner stops on failure; callers must not stop the lease twice.
    params.onSetupFailure();
    throw error;
  }
}

/** Core owns Git contents; this adapter owns only the existing lease's transport. */
export async function prepareCrabboxProjectFiles(params: {
  project: ProjectPreparation;
  binary: string;
  provider: string;
  id: string;
  runCommand: CrabboxCommandRunner;
  timeoutMs: () => number;
  signal?: AbortSignal;
  inspectPrepared?: true;
  recordRecipePreparation?: (metadata: RecipePreparation) => Promise<void>;
}) {
  const run = async (
    args: string[],
    signal: AbortSignal,
    createScript?: (timeoutMs: number) => string,
  ) => {
    params.project.assertCurrent();
    const timeoutMs = params.timeoutMs();
    const result = await runCrabboxCommand({
      action: "project preparation",
      args,
      binary: params.binary,
      runCommand: params.runCommand,
      signal: params.signal ? AbortSignal.any([signal, params.signal]) : signal,
      input: createScript?.(timeoutMs),
      timeoutMs,
    });
    params.project.assertCurrent();
    return crabboxCommandOutput("project preparation", result);
  };
  if (params.inspectPrepared) {
    if (!params.project.inspectPreparedWorkspace) {
      throw new Error("Enrolled project cannot verify its completed workspace");
    }
    await params.project.inspectPreparedWorkspace({
      runScript: (input, signal) => run(leaseRunArgs(params), signal, () => input),
    });
    return undefined;
  }
  return await params.project.prepare({
    ...(params.recordRecipePreparation
      ? { recordRecipePreparation: params.recordRecipePreparation }
      : {}),
    runScript: (input, signal) => run(leaseRunArgs(params), signal, () => input),
    runScriptWithBudget: (createScript, signal) => run(leaseRunArgs(params), signal, createScript),
    upload: async (localPath, remotePath, signal) => {
      await run(
        [
          "cp",
          "--provider",
          params.provider,
          "--id",
          params.id,
          localPath,
          `SANDBOX:${remotePath}`,
        ],
        signal,
      );
    },
  });
}
