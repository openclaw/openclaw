import { setTimeout as delay } from "node:timers/promises";
import {
  WorkerProviderError,
  type WorkerProfile,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { createCrabboxBinaryAcquisition } from "./crabbox-worker-binary-acquisition.js";
import {
  type LeaseCommandContext,
  runCrabboxCommandWithCoordinatorRetry,
  stopCrabboxLease,
} from "./crabbox-worker-command.js";
import { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import type { ParsedInspect } from "./crabbox-worker-inspect.js";
import { createCrabboxWorkerLeaseLifecycle } from "./crabbox-worker-lease-lifecycle.js";
import { createCrabboxMachineOptionsResolver } from "./crabbox-worker-machine-options.js";
import { collectCrabboxNodeEnrollmentEvidence } from "./crabbox-worker-node-enrollment-diagnostics.js";
import {
  createCrabboxNodeEnrollmentSetup,
  createCrabboxNodeRuntimeSetup,
  type CrabboxWorkerNodeEnrollment,
} from "./crabbox-worker-node-enrollment.js";
import {
  assertAwsWorkerHasNoInstanceProfile,
  assertHetznerDesktopHasManagedCoordinator,
} from "./crabbox-worker-preflight.js";
import {
  CRABBOX_WORKER_PROVIDER_ID,
  assertCrabboxLeaseId,
  operationLeaseId,
  operationSlug,
  parseCrabboxOperatingSystem,
  parseCrabboxProfile,
  resolveCrabboxProvisionProfile,
  resolveCrabboxWarmImageProfile,
} from "./crabbox-worker-profile.js";
import { prepareCrabboxProjectFiles } from "./crabbox-worker-project.js";
import type { CrabboxWorkerProviderDependencies } from "./crabbox-worker-provider.types.js";
import {
  createCrabboxProvisionAuthority,
  failCrabboxAllocation,
  failProvisionAfterCleanup,
  inspectWithContext,
  isNonRunnableState,
  prepareProvisionDesktop,
  remainingProvisionTimeout,
  runProvisionSetup,
  runProvisionWarmup,
  waitForProvisionReady,
} from "./crabbox-worker-provision-commands.js";
import {
  createCrabboxProvisionTelemetry,
  createCrabboxWorkerStageObserver,
} from "./crabbox-worker-provision-telemetry.js";
import {
  createCrabboxSnapshotActions,
  resolveCrabboxCheckpointBinaries,
  type CrabboxSnapshotActions,
} from "./crabbox-worker-snapshot-actions.js";
import {
  countCrabboxProvisionSetupPhases,
  CRABBOX_COMMAND_SETTLEMENT_TIMEOUT_MS,
  CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS,
  CRABBOX_SETUP_TIMEOUT_MS,
  CRABBOX_STOP_TIMEOUT_MS,
  CRABBOX_WARMUP_TIMEOUT_MS,
  resolveCrabboxLifecycleTimeoutMs,
  resolveCrabboxNodeEnrollmentTimeoutMs,
  resolveCrabboxProvisionBaseTimeoutMs,
  resolveCrabboxProvisionCallTimeoutMs,
  resolveCrabboxWarmImageCaptureTimeoutMs,
  WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";
import { loadCrabboxWorkerWallpaperBase64 } from "./crabbox-worker-wallpaper.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";

// Local pack creation, two seed commands, and upload precede runtime preparation and capture.
const CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS = 4 * CRABBOX_SETUP_TIMEOUT_MS;

export function createCrabboxWorkerProvider(
  dependencies: CrabboxWorkerProviderDependencies,
): WorkerProvider & { dispose: () => Promise<void>; images: CrabboxSnapshotActions } {
  const wallpaperBase64 = loadCrabboxWorkerWallpaperBase64(dependencies.wallpaperPath);
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout;
  const warn = dependencies.warn ?? (() => {});
  const sleep =
    dependencies.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const openclawRoot = dependencies.openclawRoot ?? process.cwd();
  const heartbeats = createCrabboxHeartbeatManager({
    run: (context, signal) =>
      runCrabboxCommandWithCoordinatorRetry({
        action: "heartbeat",
        args: [
          "heartbeat",
          "--provider",
          context.provider,
          "--id",
          context.id,
          // Azure Sandbox renews its creation-time idle policy; its delegated
          // heartbeat rejects timeout replacement before touching the lease.
          ...(context.provider === "azure-sandbox" ? [] : ["--idle-timeout", context.idleTimeout]),
          "--json",
        ],
        binary: context.binary,
        runCommand,
        sleep,
        signal,
        timeoutMs: context.heartbeatTimeoutMs,
      }),
    warn,
  });
  const providerAbort = new AbortController();
  const { resolveBinary, settle: settleBinaryAcquisitions } = createCrabboxBinaryAcquisition({
    ...dependencies,
    openclawRoot,
    runCommand,
    providerSignal: providerAbort.signal,
  });
  const machineOptions = createCrabboxMachineOptionsResolver({
    resolveBinary,
    runCommand,
    warn,
  });
  const warmImages = createCrabboxWarmImageManager({
    state: dependencies.state,
    runCommand,
    warn,
    policy: dependencies.warmImagePolicy,
  });
  let maintenanceInFlight: Promise<void> | undefined;
  const resolveMaintenanceBinaries = (
    profiles: readonly Parameters<typeof parseCrabboxProfile>[0][],
    signal: AbortSignal,
  ) => resolveCrabboxCheckpointBinaries({ profiles, signal, resolveBinary, warn });
  const snapshots = createCrabboxSnapshotActions({
    manager: warmImages,
    signal: providerAbort.signal,
    resolveBinaries: resolveMaintenanceBinaries,
  });
  const stopLease = async (context: LeaseCommandContext): Promise<void> => {
    await heartbeats.stop(context.id);
    // Cleanup has its own deadline. Confirmed stop or absence releases allocation/image ownership.
    await stopCrabboxLease({
      ...context,
      runCommand,
      warn,
      sleep,
    });
    await warmImages.release(context);
  };
  const resolveLeaseContext = async (lease: Parameters<WorkerProvider["inspect"]>[0]) => {
    const profile = parseCrabboxProfile(lease.profile);
    assertCrabboxLeaseId(lease.leaseId);
    return {
      context: {
        binary: await resolveBinary(profile.binary),
        heartbeatIntervalMs: profile.heartbeatIntervalMs,
        heartbeatTimeoutMs: profile.heartbeatTimeoutMs,
        id: lease.leaseId,
        idleTimeout: profile.idleTimeout,
        provider: profile.provider,
      },
      profile,
    };
  };

  const resolveAllocation: WorkerProvider["resolveAllocation"] = async (_profile, operationId) => ({
    leaseId: operationLeaseId(operationId),
    sharedHost: false,
  });

  const prepareProvision: NonNullable<WorkerProvider["prepareProvision"]> = async (
    profile: WorkerProfile,
    operationId: string,
    options: Parameters<WorkerProvider["provision"]>[2],
  ) => {
    const { signal, assertCurrent } = createCrabboxProvisionAuthority(options);
    const executionMode: unknown = options?.executionMode;
    if (
      executionMode !== undefined &&
      executionMode !== "worker-turn" &&
      executionMode !== "remote-exec"
    ) {
      throw new WorkerProviderError("Crabbox execution mode is unsupported");
    }
    const { profile: parsed, forwardedEnv } = resolveCrabboxProvisionProfile(
      profile,
      options?.machineClass,
      options?.os,
    );
    const nodeRuntimeIdentity = options?.nodeRuntimeIdentity;
    if (parsed.warmImage && !nodeRuntimeIdentity) {
      throw new WorkerProviderError("Crabbox warm images require a prepared node runtime identity");
    }
    const warmupTimeoutMs = parsed.desktop
      ? CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS
      : CRABBOX_WARMUP_TIMEOUT_MS;
    const project =
      parsed.warmImage || (parsed.target === "linux" && parsed.class && !parsed.setupEnv?.length)
        ? options?.project
        : undefined;
    if (options?.project?.preparation && (!project || parsed.setupEnv?.length)) {
      throw new WorkerProviderError(
        "Crabbox prepared workers require a Linux machine class and immutable setup inputs without setupEnv",
      );
    }
    const preparationSignal =
      signal && project ? AbortSignal.any([signal, project.signal]) : (signal ?? project?.signal);
    const allocation = await resolveAllocation(profile, operationId);
    signal?.throwIfAborted();
    const binary = await resolveBinary(parsed.binary, preparationSignal);
    preparationSignal?.throwIfAborted();
    const deadline = Date.now() + resolveCrabboxProvisionBaseTimeoutMs(parsed);
    const nodeBootstrapTimeoutMs = resolveCrabboxNodeEnrollmentTimeoutMs(
      options?.nodeBootstrapTimeoutMs,
    );
    const setupDeadline =
      deadline +
      countCrabboxProvisionSetupPhases(parsed) * CRABBOX_SETUP_TIMEOUT_MS +
      2 * nodeBootstrapTimeoutMs +
      (project
        ? CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS +
          (parsed.warmImage ? resolveCrabboxWarmImageCaptureTimeoutMs(parsed.provider) : 0)
        : 0);
    const context = { binary, provider: parsed.provider };
    const leaseId = allocation.leaseId;
    const telemetry = createCrabboxProvisionTelemetry(
      operationId,
      leaseId,
      dependencies.onProvisionStage ?? (() => {}),
    );
    const observeWorkerStage = () =>
      createCrabboxWorkerStageObserver(
        leaseId,
        operationId,
        dependencies.onProvisionStage ?? (() => {}),
      );
    if (parsed.desktop && parsed.provider === "hetzner") {
      await assertHetznerDesktopHasManagedCoordinator({ binary, runCommand, signal });
    }
    if (parsed.provider === "aws") {
      await assertAwsWorkerHasNoInstanceProfile({ binary, runCommand, signal });
    }

    return async () => {
      assertCurrent();
      // Completed setup can survive a crash before its capture requirement returns.
      // Sample before allocate creates the first-call record; enrolled replay stays closed.
      const priorAllocation =
        parsed.warmImage && project?.preparation && (await warmImages.lookupLease(leaseId));
      const preparedReplay = priorAllocation && priorAllocation.phase !== "enrolled";
      const allocationContext = {
        ...context,
        id: leaseId,
        profile: parsed,
        profileId: options?.profileId,
        nodeRuntimeIdentity,
        ...(project
          ? { projectKey: project.key, projectLabel: project.label, projectRoot: project.root }
          : {}),
        ...(project?.preparation ? { preparation: project.preparation } : {}),
        assertCurrent,
        signal: preparationSignal,
        slug: operationSlug(operationId),
        timeoutMs: () => remainingProvisionTimeout(deadline, warmupTimeoutMs),
      };
      // Cold project preparation retains no image state; both paths keep the fixed lease.
      const allocationChoice = await (
        project && !parsed.warmImage
          ? telemetry
              .stage("cold-warmup", () => runProvisionWarmup({ ...allocationContext, runCommand }))
              .then(() => ({ kind: "cold" as const }))
          : telemetry.stage("allocation", () => warmImages.allocate(allocationContext))
      ).catch((error: unknown) =>
        failCrabboxAllocation(error, {
          operationId,
          assertCurrent,
          release: () => warmImages.release({ ...context, id: leaseId }),
        }),
      );
      let inspected: ParsedInspect | undefined;
      try {
        inspected = await telemetry.stage("lease-inspect", () =>
          inspectWithContext({
            ...context,
            id: leaseId,
            runCommand,
            sleep,
            timeoutMs: remainingProvisionTimeout(
              deadline,
              resolveCrabboxLifecycleTimeoutMs(parsed.provider),
            ),
            waitForReady: parsed.provider === "machine0",
            signal: preparationSignal,
          }),
        );
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        // Transport failure after warmup is indeterminate; preserve the lease for durable replay.
        if (error instanceof WorkerProviderError) {
          return await failProvisionAfterCleanup({ ...context, id: leaseId, stopLease }, error);
        }
        throw error;
      }
      if (!inspected) {
        throw new Error("Crabbox warmup lease was not found during inspection");
      }
      const inspectedParams = {
        ...context,
        operationId,
        deadline,
        inspect: inspected,
        profile: parsed,
        runCommand,
        stopLease,
        sleep,
        signal: preparationSignal,
      };
      if (isNonRunnableState(inspected.state)) {
        return await failProvisionAfterCleanup(
          { ...inspectedParams, id: leaseId },
          new WorkerProviderError(
            `Crabbox warmup lease entered a terminal state${inspected.failureError ? `: ${inspected.failureError}` : ""}`,
          ),
        );
      }
      inspectedParams.inspect = await telemetry.stage("ssh-ready", () =>
        waitForProvisionReady({ ...inspectedParams, sleep }),
      );
      inspectedParams.deadline = setupDeadline;
      const profileSetup = parsed.setup;
      if (profileSetup && !(project?.preparation && allocationChoice.kind === "checkpoint")) {
        inspectedParams.inspect = await telemetry.stage("profile-setup", async () => {
          await runProvisionSetup({
            ...inspectedParams,
            phase: "profile setup",
            setup: profileSetup,
            forwardedEnv,
          });
          // Setup may restart SSH; refresh its endpoint and security attestation before bootstrap.
          return await waitForProvisionReady({
            ...inspectedParams,
            refresh: true,
            sleep,
          });
        });
      }
      const desktop = await telemetry.stage("desktop-preparation", () =>
        prepareProvisionDesktop({
          ...inspectedParams,
          wallpaperBase64,
          prepareBeforeEnrollment: Boolean(project),
        }),
      );
      const projectEnrolled =
        parsed.warmImage &&
        project &&
        (await warmImages.lookupLease(leaseId))?.phase === "enrolled";
      if (project?.preparation && projectEnrolled) {
        // An enrolled replay may have lost its response before core registration.
        // Verify the preserved completion only; setup and capture remain closed.
        try {
          await prepareCrabboxProjectFiles({
            ...context,
            id: leaseId,
            project,
            inspectPrepared: true,
            runCommand,
            signal: preparationSignal,
            timeoutMs: () => remainingProvisionTimeout(setupDeadline, CRABBOX_SETUP_TIMEOUT_MS),
          });
        } catch (error) {
          preparationSignal?.throwIfAborted();
          return await failProvisionAfterCleanup({ ...context, id: leaseId, stopLease }, error);
        }
      }
      if (project && !projectEnrolled) {
        let preparationFailed = false;
        let captured = false;
        try {
          const preparedProject = await telemetry.stage("project-preparation", () =>
            prepareCrabboxProjectFiles({
              ...context,
              id: leaseId,
              project,
              runCommand,
              signal: preparationSignal,
              timeoutMs: () => remainingProvisionTimeout(setupDeadline, CRABBOX_SETUP_TIMEOUT_MS),
            }),
          );
          assertCurrent();
          if (parsed.warmImage) {
            await warmImages.markPrepared(leaseId, project.baseCommit, () => {
              preparationSignal?.throwIfAborted();
              assertCurrent();
            });
            captured = await telemetry.stage("warm-image-capture", () =>
              warmImages.capture(
                {
                  ...context,
                  id: leaseId,
                  profile: parsed,
                  signal: preparationSignal,
                  assertCurrent,
                  projectCaptureRequired:
                    preparedProject?.captureRequired || preparedReplay ? true : undefined,
                  projectCaptureReplay: preparedReplay ? true : undefined,
                  ...(allocationChoice.kind === "checkpoint"
                    ? { forkedCheckpointId: allocationChoice.checkpointId }
                    : {}),
                },
                async (scrubScript) => {
                  if (!options?.prepareNodeRuntime) {
                    throw new Error("Crabbox project snapshots require node runtime preparation");
                  }
                  const runtime = await options.prepareNodeRuntime();
                  signal?.throwIfAborted();
                  assertCurrent();
                  const setup = createCrabboxNodeRuntimeSetup({
                    nodeBootstrap: runtime.nodeBootstrap,
                    workerBundle: runtime.workerBundle,
                    leaseId,
                  });
                  try {
                    await runProvisionSetup({
                      ...inspectedParams,
                      phase: "node runtime preparation",
                      onOutputChunk: observeWorkerStage(),
                      // Node clears its own environment; scrub must also inherit no shell credentials.
                      setup: `${setup.command}\nunset ${Object.keys(setup.forwardedEnv).join(" ")}\n${scrubScript}`,
                      forwardedEnv: setup.forwardedEnv,
                      timeoutMs:
                        resolveCrabboxNodeEnrollmentTimeoutMs(runtime.bootstrapTimeoutMs) +
                        WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
                      signal:
                        runtime.signal && preparationSignal
                          ? AbortSignal.any([preparationSignal, runtime.signal])
                          : (preparationSignal ?? runtime.signal),
                    });
                  } catch (error) {
                    // The command owner settles setup failure and cleanup; do not stop it twice.
                    preparationFailed = true;
                    throw error;
                  }
                },
              ),
            );
          }
        } catch (error) {
          // The runtime grant has a separate abort signal; revalidate the project owner.
          signal?.throwIfAborted();
          assertCurrent();
          if (preparationFailed) {
            throw error;
          }
          return await failProvisionAfterCleanup({ ...context, id: leaseId, stopLease }, error);
        }
        // Only native capture can have restarted the source since preparation returned.
        if (captured) {
          inspectedParams.inspect = await telemetry.stage("post-capture-ssh-ready", () =>
            waitForProvisionReady({
              ...inspectedParams,
              refresh: true,
              sleep,
            }),
          );
        }
      }
      signal?.throwIfAborted();
      assertCurrent();
      const beginNodeEnrollment = options?.beginNodeEnrollment;
      if (!beginNodeEnrollment) {
        return await failProvisionAfterCleanup(
          { ...inspectedParams, id: leaseId },
          new Error("Crabbox worker node enrollment is unavailable"),
        );
      }
      let enrollment: CrabboxWorkerNodeEnrollment;
      let runtimeSetupFailed = false;
      try {
        if (!project && options?.prepareNodeRuntime) {
          const runtime = await options.prepareNodeRuntime();
          assertCurrent();
          const setup = createCrabboxNodeRuntimeSetup({
            nodeBootstrap: runtime.nodeBootstrap,
            workerBundle: runtime.workerBundle,
            leaseId,
            target: parsed.target,
          });
          await telemetry
            .stage(
              "runtime-preparation",
              () =>
                runProvisionSetup({
                  ...inspectedParams,
                  phase: "node runtime preparation",
                  onOutputChunk: observeWorkerStage(),
                  setup: setup.command,
                  forwardedEnv: setup.forwardedEnv,
                  timeoutMs: resolveCrabboxNodeEnrollmentTimeoutMs(runtime.bootstrapTimeoutMs),
                  signal:
                    preparationSignal && runtime.signal
                      ? AbortSignal.any([preparationSignal, runtime.signal])
                      : (preparationSignal ?? runtime.signal),
                }),
              { caller: signal, runtime: runtime.signal },
            )
            .catch((error: unknown) => {
              // Setup owns failure cleanup; the enrollment catch must not stop the lease twice.
              runtimeSetupFailed = true;
              throw error;
            });
          assertCurrent();
        }
        enrollment = await telemetry.stage("enrollment-authority", beginNodeEnrollment);
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        if (runtimeSetupFailed) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        return await failProvisionAfterCleanup({ ...inspectedParams, id: leaseId }, error);
      }
      const nodeEnrollmentSetup = createCrabboxNodeEnrollmentSetup({
        enrollment,
        desktop: parsed.desktop,
        desktopSetup: project ? undefined : desktop?.setup,
        target: parsed.target,
        leaseId,
      });
      const enrollmentSignal =
        preparationSignal && enrollment.signal
          ? AbortSignal.any([preparationSignal, enrollment.signal])
          : (preparationSignal ?? enrollment.signal);
      // These owned scripts do not restart SSH; authenticated enrollment proves node readiness.
      await telemetry.stage(
        "node-bootstrap",
        () =>
          runProvisionSetup({
            ...inspectedParams,
            phase: "node enrollment setup",
            onOutputChunk: observeWorkerStage(),
            signal: enrollmentSignal,
            setup: nodeEnrollmentSetup.command,
            // Combine the existing phase budgets; desktop work starts after node launch.
            timeoutMs:
              resolveCrabboxNodeEnrollmentTimeoutMs(enrollment.bootstrapTimeoutMs) +
              (desktop && !project ? CRABBOX_SETUP_TIMEOUT_MS : 0),
            forwardedEnv: nodeEnrollmentSetup.forwardedEnv,
          }),
        { caller: signal, project: project?.signal, runtime: enrollment.signal },
      );
      let deviceId: string;
      try {
        deviceId = await telemetry.stage("device-enrollment", () => enrollment.waitForDeviceId());
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        // Gateway shutdown cancels its wait, not the fixed operation-owned provider lease.
        if (enrollment.signal?.aborted) {
          throw error;
        }
        const leaseContext = { ...inspectedParams, id: leaseId };
        // Read node evidence before cleanup destroys its only copy on the leased machine.
        const evidence = await collectCrabboxNodeEnrollmentEvidence({
          ...leaseContext,
          target: parsed.target,
          ...(enrollmentSignal ? { signal: enrollmentSignal } : {}),
        });
        signal?.throwIfAborted();
        enrollment.signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : "Worker node enrollment failed";
        return await failProvisionAfterCleanup(
          leaseContext,
          new Error(`${message}; ${evidence}`, { cause: error }),
        );
      }
      if (parsed.warmImage) {
        await warmImages.markEnrolled(leaseId, () => {
          signal?.throwIfAborted();
          enrollment.signal?.throwIfAborted();
        });
        signal?.throwIfAborted();
        enrollment.signal?.throwIfAborted();
      }
      heartbeats.start({
        binary,
        heartbeatIntervalMs: parsed.heartbeatIntervalMs,
        heartbeatTimeoutMs: parsed.heartbeatTimeoutMs,
        id: leaseId,
        idleTimeout: parsed.idleTimeout,
        provider: parsed.provider,
      });
      return {
        ...allocation,
        node: { deviceId },
        ...(desktop ? { desktop: desktop.endpoint } : {}),
      };
    };
  };

  return {
    id: CRABBOX_WORKER_PROVIDER_ID,
    resolveDisplayId: (profile) => parseCrabboxProfile(profile).provider,
    supportsFailedLeaseHold: (profile) => parseCrabboxProfile(profile).provider === "azure",
    // Disposable worker desktops may resize only when the RFB server negotiates support.
    allowsDesktopResize: true,
    async dispose() {
      providerAbort.abort();
      await Promise.all([
        heartbeats.dispose(),
        maintenanceInFlight?.catch(() => {}),
        snapshots.settle(),
        settleBinaryAcquisitions(),
      ]);
    },
    images: snapshots.images,
    maintain(context) {
      context.assertCurrent();
      providerAbort.signal.throwIfAborted();
      return (maintenanceInFlight ??= Promise.resolve()
        .then(async () => {
          const signal = AbortSignal.any([context.signal, providerAbort.signal]);
          const assertCurrent = () => {
            signal.throwIfAborted();
            context.assertCurrent();
          };
          assertCurrent();
          // Records have no binary owner: try sorted executables until deletion or all report absent.
          // Crabbox prints `checkpoint absent id=<id>` with exit 0 (internal/cli/checkpoint.go).
          const resolvedBinaries = await resolveMaintenanceBinaries(context.profiles, signal);
          assertCurrent();
          await warmImages.maintain({
            binaries: resolvedBinaries,
            signal,
            assertCurrent,
          });
        })
        .finally(() => {
          maintenanceInFlight = undefined;
        }));
    },
    ...machineOptions,
    supportedExecutionModes: ["worker-turn", "remote-exec"],
    provisionBeforeInstallation: true,
    requiresNodeEnrollment: true,
    supportsProjectPreparation(profile, machineClass, os) {
      const parsed = parseCrabboxProfile(profile);
      const effective = resolveCrabboxWarmImageProfile(
        parsed,
        machineClass ?? parsed.class,
        os === undefined ? parsed.target : parseCrabboxOperatingSystem(os),
      );
      return (
        effective.warmImage ||
        Boolean(effective.target === "linux" && effective.class && !effective.setupEnv?.length)
      );
    },
    resolvePreparedIdleTimeoutMs(profile) {
      const parsed = parseCrabboxProfile(profile);
      return parsed.target !== "linux" || parsed.setupEnv?.length
        ? undefined
        : parsed.idleTimeoutMs;
    },
    resolvePreparationTarget(profile, machineClass, os) {
      const parsed = parseCrabboxProfile(profile);
      const effective = resolveCrabboxWarmImageProfile(
        parsed,
        machineClass ?? parsed.class,
        os === undefined ? parsed.target : parseCrabboxOperatingSystem(os),
      );
      return effective.target === "linux" && effective.class && !effective.setupEnv?.length
        ? { machineClass: effective.class, platform: effective.target }
        : undefined;
    },
    async notePreparedDemand(lease, preparation) {
      if (parseCrabboxProfile(lease.profile).warmImage !== false) {
        await warmImages.notePreparedDemand(lease.leaseId, preparation);
      }
    },
    resolveAllocation,
    resolveProvisionTimeoutMs(profile, options) {
      const parsed = parseCrabboxProfile(profile);
      return (
        resolveCrabboxProvisionCallTimeoutMs(parsed, options?.nodeBootstrapTimeoutMs) +
        (parsed.warmImage === false && parsed.target === "linux" && !parsed.setupEnv?.length
          ? CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS
          : 0) +
        (parsed.warmImage === false
          ? 0
          : CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS +
            resolveCrabboxWarmImageCaptureTimeoutMs(parsed.provider))
      );
    },
    resolveDestroyTimeoutMs(profile) {
      const parsed = parseCrabboxProfile(profile);
      // Lifecycle profiles omit placement sizing. Reserve capture unless disabled,
      // plus separate heartbeat and stop child settlement.
      return (
        CRABBOX_STOP_TIMEOUT_MS +
        2 * CRABBOX_COMMAND_SETTLEMENT_TIMEOUT_MS +
        (parsed.warmImage === false ? 0 : resolveCrabboxWarmImageCaptureTimeoutMs(parsed.provider))
      );
    },
    prepareProvision,
    async provision(...args) {
      return await (
        await prepareProvision(...args)
      )();
    },
    ...createCrabboxWorkerLeaseLifecycle({
      runCommand,
      sleep,
      signal: providerAbort.signal,
      heartbeats,
      resolveLeaseContext,
      warmImages,
      stopLease,
      warn,
    }),
  };
}
