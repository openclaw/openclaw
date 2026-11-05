import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { measureCrabboxProvisionPhase } from "./crabbox-provision-timing.js";
import { crabboxCommandOutput, leaseRunArgs, runCrabboxCommand } from "./crabbox-worker-command.js";
import type { createCrabboxWorkerLeaseLifecycle } from "./crabbox-worker-lease-lifecycle.js";
import { createCrabboxNodeRuntimeSetup } from "./crabbox-worker-node-enrollment.js";
import {
  remainingProvisionTimeout,
  runProvisionSetup,
} from "./crabbox-worker-provision-commands.js";
import { runCrabboxSetupEgress } from "./crabbox-worker-setup-egress.js";
import { crabboxProjectSnapshotFailure } from "./crabbox-worker-snapshot-verifier.js";
import {
  CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS,
  CRABBOX_SETUP_TIMEOUT_MS,
  resolveCrabboxNodeEnrollmentTimeoutMs,
  WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";
import type { RecipePreparation } from "./crabbox-worker-warm-image-recipe.js";

type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;

export function createCrabboxPreparedProjectRefresh(params: {
  signal: AbortSignal;
  resolveLeaseContext: ReturnType<typeof createCrabboxWorkerLeaseLifecycle>["resolveLeaseContext"];
}): NonNullable<WorkerProvider["refreshPreparedProject"]> {
  return async (lease, project) => {
    const signal = AbortSignal.any([params.signal, project.signal]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      project.assertCurrent();
    };
    assertCurrent();
    const { context, profile } = await params.resolveLeaseContext({ ...lease, signal });
    assertCurrent();
    const deadline = performance.now() + CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS;
    await prepareCrabboxProjectFiles({
      ...context,
      project,
      signal,
      setupSecrets: profile.setupSecrets,
      assertCurrent,
      timeoutMs: () => remainingProvisionTimeout(deadline, CRABBOX_SETUP_TIMEOUT_MS),
    });
    assertCurrent();
  };
}

export async function prepareCrabboxWorkerRuntime(params: {
  context: Omit<Parameters<typeof runProvisionSetup>[0], "phase" | "setup">;
  prepareNodeRuntime: NonNullable<Parameters<WorkerProvider["provision"]>[2]>["prepareNodeRuntime"];
  leaseId: string;
  project?: ProjectPreparation;
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
  const timeoutMs = resolveCrabboxNodeEnrollmentTimeoutMs(runtime.bootstrapTimeoutMs);
  return {
    timeoutMs,
    async run(scrubScript?: string) {
      params.context.signal?.throwIfAborted();
      runtime.signal?.throwIfAborted();
      params.assertCurrent();
      try {
        await runProvisionSetup({
          ...params.context,
          phase: "node runtime preparation",
          // Node clears its own environment; scrub must also inherit no shell credentials.
          setup: scrubScript
            ? `${setup.command}\nunset ${Object.keys(setup.forwardedEnv).join(" ")}\n${scrubScript}`
            : setup.command,
          forwardedEnv: setup.forwardedEnv,
          timeoutMs: timeoutMs + (scrubScript ? WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS : 0),
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
      if (scrubScript && params.project) {
        await prepareCrabboxProjectFiles({
          ...params.context,
          id: params.leaseId,
          project: params.project,
          snapshot: true,
          signal: params.preparationSignal,
          assertCurrent: params.assertCurrent,
          timeoutMs: () =>
            remainingProvisionTimeout(params.context.deadline, CRABBOX_SETUP_TIMEOUT_MS),
        });
      }
    },
  };
}

/** Core owns Git contents; this adapter owns only the existing lease's transport. */
export async function prepareCrabboxProjectFiles(params: {
  project: ProjectPreparation;
  binary: string;
  provider: string;
  id: string;
  timeoutMs: () => number;
  signal?: AbortSignal;
  inspectPrepared?: true;
  snapshot?: true;
  recordRecipePreparation?: (metadata: RecipePreparation) => Promise<void>;
  setupSecrets?: Readonly<Record<string, SecretRef>>;
  assertCurrent?: () => void;
}) {
  const run = async (
    args: string[],
    signal: AbortSignal,
    createScript?: (timeoutMs: number, setupEnv?: Record<string, string>) => string,
  ) => {
    params.project.assertCurrent();
    const timeoutMs = params.timeoutMs();
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      params.project.assertCurrent();
      params.assertCurrent?.();
    };
    const commandSignal = params.signal ? AbortSignal.any([signal, params.signal]) : signal;
    const result =
      createScript && Object.keys(params.setupSecrets ?? {}).length
        ? await runCrabboxSetupEgress({
            ...params,
            secrets: params.setupSecrets ?? {},
            createScript: (env) => createScript(timeoutMs, env),
            signal: commandSignal,
            timeoutMs,
            assertCurrent,
          })
        : await runCrabboxCommand({
            action: "project preparation",
            args,
            binary: params.binary,
            signal: commandSignal,
            input: createScript?.(timeoutMs),
            timeoutMs,
            assertCurrent,
          });
    assertCurrent();
    if (params.snapshot && (result.termination !== "exit" || result.code !== 0)) {
      throw crabboxProjectSnapshotFailure(result.stderr);
    }
    return crabboxCommandOutput("project preparation", result);
  };
  if (params.snapshot) {
    const prepareSnapshot = params.project.prepareSnapshot;
    if (params.project.preparation && !prepareSnapshot) {
      throw new Error("Prepared project has no snapshot verification owner");
    }
    await measureCrabboxProvisionPhase("snapshot.verification", async () => {
      await prepareSnapshot?.({
        runScript: (input, signal) => run(leaseRunArgs(params), signal, () => input),
      });
    });
    return undefined;
  }
  if (params.inspectPrepared) {
    if (!params.project.inspectPreparedWorkspace) {
      throw new Error("Enrolled project cannot verify its completed workspace");
    }
    await params.project.inspectPreparedWorkspace({
      runScript: (input, signal) => run(leaseRunArgs(params), signal, () => input),
    });
    return undefined;
  }
  return await measureCrabboxProvisionPhase("project.preparation", () =>
    params.project.prepare({
      ...(params.recordRecipePreparation
        ? { recordRecipePreparation: params.recordRecipePreparation }
        : {}),
      runScript: (input, signal) => run(leaseRunArgs(params), signal, () => input),
      runScriptWithBudget: (createScript, signal) =>
        run(leaseRunArgs(params), signal, createScript),
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
    }),
  );
}
