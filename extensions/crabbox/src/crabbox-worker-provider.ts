import { isDeepStrictEqual } from "node:util";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  WorkerProviderError,
  type WorkerProfile,
  type WorkerProvider,
  type WorkerResourceReceipt,
} from "openclaw/plugin-sdk/plugin-entry";
import type { LeaseCommandContext } from "./crabbox-worker-command.js";
import { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import type { ParsedInspect } from "./crabbox-worker-inspect.js";
import { createCrabboxWorkerLeaseLifecycle } from "./crabbox-worker-lease-lifecycle.js";
import { prepareCrabboxCaptureLifetime } from "./crabbox-worker-lifetime.js";
import { createCrabboxMachineOptionsResolver } from "./crabbox-worker-machine-options.js";
import { collectCrabboxNodeEnrollmentEvidence } from "./crabbox-worker-node-enrollment-diagnostics.js";
import {
  createCrabboxNodeEnrollmentSetup,
  type CrabboxWorkerNodeEnrollment,
} from "./crabbox-worker-node-enrollment.js";
import {
  assertAwsWorkerHasNoInstanceProfile,
  assertHetznerDesktopHasManagedCoordinator,
} from "./crabbox-worker-preflight.js";
import {
  CRABBOX_WORKER_PROVIDER_ID,
  operationLeaseId,
  operationSlug,
  parseCrabboxProfile,
  parseCrabboxCleanupProfile,
  resolveCrabboxProvisionProfile,
  resolveCrabboxPreparationTarget,
  resolveCrabboxPreparedIdleTimeoutMs,
  supportsCrabboxProjectPreparation,
} from "./crabbox-worker-profile.js";
import {
  prepareCrabboxProjectFiles,
  prepareCrabboxWorkerRuntime,
} from "./crabbox-worker-project.js";
import { createCrabboxWorkerBinaryResolver } from "./crabbox-worker-provider-binary.js";
import {
  createCrabboxProvisionAuthority,
  failProvisionAfterCleanup,
  inspectWithContext,
  isNonRunnableState,
  prepareProvisionDesktop,
  remainingProvisionTimeout,
  runProvisionSetup,
  waitForProvisionReady,
} from "./crabbox-worker-provision-commands.js";
import { assertCrabboxResourceReceipt } from "./crabbox-worker-resource-receipt.js";
import {
  assertCrabboxRetentionSupport,
  prepareCrabboxRetention,
} from "./crabbox-worker-retention.js";
import {
  assertCrabboxSetupEgressSupport,
  createCrabboxSetupCommandRunner,
} from "./crabbox-worker-setup-egress.js";
import {
  createCrabboxSnapshotActions,
  resolveCrabboxCheckpointBinaries,
  type CrabboxSnapshotActions,
} from "./crabbox-worker-snapshot-actions.js";
import { createCrabboxWorkerTeardown } from "./crabbox-worker-teardown.js";
import {
  countCrabboxProvisionSetupPhases,
  CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS,
  CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS,
  CRABBOX_SETUP_TIMEOUT_MS,
  CRABBOX_WARMUP_TIMEOUT_MS,
  resolveCrabboxDestroyTimeoutMs,
  resolveCrabboxLifecycleTimeoutMs,
  resolveCrabboxNodeEnrollmentTimeoutMs,
  resolveCrabboxProvisionBaseTimeoutMs,
  resolveCrabboxProvisionCallTimeoutMs,
  resolveCrabboxWarmImageCaptureTimeoutMs,
} from "./crabbox-worker-timeouts.js";
import { loadCrabboxWorkerWallpaperBase64 } from "./crabbox-worker-wallpaper.js";
import type { CrabboxWarmImagePolicy } from "./crabbox-worker-warm-image-policy.js";
import type { CrabboxState } from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";

type CrabboxWorkerProviderDependencies = {
  openclawRoot?: string;
  wallpaperPath: string;
  state: CrabboxState;
  warn?: (message: string) => void;
  info?: (message: string) => void;
  warmImagePolicy?: CrabboxWarmImagePolicy;
};

export function createCrabboxWorkerProvider(
  dependencies: CrabboxWorkerProviderDependencies,
): WorkerProvider & { dispose: () => Promise<void>; images: CrabboxSnapshotActions } {
  const wallpaperBase64 = loadCrabboxWorkerWallpaperBase64(dependencies.wallpaperPath);
  const warn = dependencies.warn ?? (() => {});
  const openclawRoot = dependencies.openclawRoot ?? process.cwd();
  const heartbeats = createCrabboxHeartbeatManager({
    warn,
  });
  const providerAbort = new AbortController();
  const binaryResolver = createCrabboxWorkerBinaryResolver({
    openclawRoot,
    signal: providerAbort.signal,
    warn,
  });
  const resolveBinary = binaryResolver.resolve;
  const machineOptions = createCrabboxMachineOptionsResolver({
    resolveBinary: async (...args) => (await resolveBinary(...args)).binary,
    warn,
  });
  const activeProvisions = new Set<{ leaseId: string }>();
  const warmImages = createCrabboxWarmImageManager({
    isLeaseActive: (leaseId) => {
      for (const owner of activeProvisions) {
        if (owner.leaseId === leaseId) {
          return true;
        }
      }
      return false;
    },
    state: dependencies.state,
    warn,
    info: dependencies.info,
    policy: dependencies.warmImagePolicy,
    prepareCapture: async (context) => {
      heartbeats.start({ ...context.profile, ...context });
      await prepareCrabboxCaptureLifetime(context, {
        observe: (inspected) =>
          heartbeats.start({
            ...context.profile,
            ...context,
            lifetime: inspected.lifetime,
          }),
      });
    },
  });
  let maintenanceInFlight: Promise<void> | undefined;
  const resolveMaintenanceBinaries = (
    profiles: readonly Parameters<typeof parseCrabboxProfile>[0][],
    signal: AbortSignal,
  ) =>
    resolveCrabboxCheckpointBinaries({
      profiles,
      signal,
      resolveBinary: async (...args) => (await resolveBinary(...args)).binary,
      warn,
    });
  const snapshots = createCrabboxSnapshotActions({
    manager: warmImages,
    signal: providerAbort.signal,
    resolveBinaries: resolveMaintenanceBinaries,
  });
  const leaseLifecycle = createCrabboxWorkerLeaseLifecycle({
    resolveBinary,
    heartbeats,
    signal: providerAbort.signal,
  });
  const { resolveLeaseContext } = leaseLifecycle;

  const { stopLease, destroy } = createCrabboxWorkerTeardown({
    heartbeats,
    warmImages,
    providerSignal: providerAbort.signal,
    warn,
    resolveLeaseContext,
  });

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
    const { profile: parsed } = resolveCrabboxProvisionProfile(
      profile,
      options?.machineClass,
      options?.os,
    );
    const retention = options?.retention && prepareCrabboxRetention(parsed, options.retention);
    const receiptRequired = parsed.provider === "azure-sandbox";
    const recordResourceReceipt = options?.recordResourceReceipt;
    if (receiptRequired && !recordResourceReceipt) {
      throw new WorkerProviderError(
        "Crabbox Azure Sandbox requires Gateway resource receipt persistence",
      );
    }
    if (
      options?.resourceReceipt &&
      (!receiptRequired || options.resourceReceipt.identity.provider !== parsed.provider)
    ) {
      throw new Error("Crabbox resource receipt does not match the selected provider");
    }
    let resourceReceipt: WorkerResourceReceipt | undefined = options?.resourceReceipt;
    const stopProvisionLease = (context: LeaseCommandContext) =>
      stopLease({ ...context, resourceReceipt, assertCurrent });
    const nodeRuntimeIdentity = options?.nodeRuntimeIdentity;
    if (parsed.warmImage && !nodeRuntimeIdentity) {
      throw new WorkerProviderError("Crabbox warm images require a prepared node runtime identity");
    }
    const warmupTimeoutMs = parsed.desktop
      ? CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS
      : CRABBOX_WARMUP_TIMEOUT_MS;
    const protectedSetup = Object.keys(parsed.setupSecrets ?? {}).length > 0;
    const project = supportsCrabboxProjectPreparation(profile, options?.machineClass, options?.os)
      ? options?.project
      : undefined;
    if (options?.project?.preparation && !project) {
      throw new WorkerProviderError(
        "Crabbox prepared workers require warm images, protected setup, or a configured Linux Sandbox disk",
      );
    }
    const preparationSignal = AbortSignal.any([
      providerAbort.signal,
      ...(signal ? [signal] : []),
      ...(project?.signal ? [project.signal] : []),
    ]);
    const allocation = await resolveAllocation(profile, operationId);
    signal?.throwIfAborted();
    const { binary, version: cliVersion } = await resolveBinary(parsed.binary, preparationSignal);
    preparationSignal?.throwIfAborted();
    if (retention) {
      await assertCrabboxRetentionSupport({ binary, signal: preparationSignal });
      assertCurrent();
    }
    if (protectedSetup) {
      await assertCrabboxSetupEgressSupport({
        binary,
        target: parsed.target,
        assertCurrent,
        signal: preparationSignal,
        projectPrepared: project ? Boolean(project.preparation) : undefined,
      });
    }
    const deadline = performance.now() + resolveCrabboxProvisionBaseTimeoutMs(parsed);
    const nodeBootstrapTimeoutMs = resolveCrabboxNodeEnrollmentTimeoutMs(
      options?.nodeBootstrapTimeoutMs,
    );
    const setupDeadline =
      deadline +
      countCrabboxProvisionSetupPhases(parsed) * CRABBOX_SETUP_TIMEOUT_MS +
      2 * nodeBootstrapTimeoutMs +
      (project
        ? CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS +
          resolveCrabboxWarmImageCaptureTimeoutMs(parsed.provider)
        : 0);
    const context = {
      ...warmImages.startContext(binary, parsed.provider, options, Boolean(project)),
      ...(retention ? { retention } : {}),
    };
    const leaseId = allocation.leaseId;
    if (parsed.desktop && parsed.provider === "hetzner") {
      await assertHetznerDesktopHasManagedCoordinator({ binary, signal });
    }
    if (parsed.provider === "aws") {
      await assertAwsWorkerHasNoInstanceProfile({ binary, signal });
    }

    const provision = async () => {
      assertCurrent();
      if (resourceReceipt) {
        const observed = await inspectWithContext({
          ...context,
          id: leaseId,
          resourceReceipt,
          signal: preparationSignal,
        });
        assertCurrent();
        assertCrabboxResourceReceipt(resourceReceipt, observed?.resourceReceipt);
        if (retention && observed) {
          await waitForProvisionReady({
            ...context,
            deadline,
            inspect: observed,
            resourceReceipt,
            profile: parsed,
            stopLease: stopProvisionLease,
            signal: preparationSignal,
            assertCurrent,
          });
          assertCurrent();
        }
      }
      // Completed setup can survive a crash before its capture requirement returns.
      // Sample before allocate creates the first-call record; enrolled replay stays closed.
      const priorAllocation = project?.preparation && (await warmImages.lookupLease(leaseId));
      const preparedReplay = priorAllocation && priorAllocation.phase !== "enrolled";
      const allocationChoice = await warmImages.allocate({
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
      });
      let provisioned = false;
      try {
        let inspected: ParsedInspect | undefined;
        try {
          inspected = await inspectWithContext({
            ...context,
            id: leaseId,
            timeoutMs: remainingProvisionTimeout(
              deadline,
              resolveCrabboxLifecycleTimeoutMs(parsed.provider),
            ),
            waitForReady: parsed.provider === "machine0",
            signal: preparationSignal,
          });
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          // Resource qualification failures (including retained or malformed observations)
          // cannot authorize cleanup or terminalize an allocation whose identity is unknown.
          if (receiptRequired) {
            throw new Error(
              `Crabbox resource qualification failed; allocation preserved: ${coerceErrorMessage(error)}`,
              { cause: error },
            );
          }
          // Transport failure after warmup is indeterminate; preserve the lease for durable replay.
          if (error instanceof WorkerProviderError) {
            return await failProvisionAfterCleanup(
              { ...context, id: leaseId, stopLease: stopProvisionLease },
              error,
            );
          }
          throw error;
        }
        if (!inspected) {
          throw new Error("Crabbox warmup lease was not found during inspection");
        }
        if (receiptRequired) {
          const observed = inspected.resourceReceipt;
          if (!observed || !recordResourceReceipt) {
            throw new Error("Crabbox allocation has no qualified resource receipt");
          }
          if (resourceReceipt) {
            assertCrabboxResourceReceipt(resourceReceipt, observed);
          }
          await recordResourceReceipt(observed);
          assertCurrent();
          resourceReceipt = observed;
        }
        // The provider owns idle protection as soon as allocation is known,
        // including readiness, transfer, enrollment, and admitted capture.
        if (!retention) {
          heartbeats.start({
            binary,
            id: leaseId,
            provider: parsed.provider,
            heartbeatIntervalMs: parsed.heartbeatIntervalMs,
            heartbeatTimeoutMs: parsed.heartbeatTimeoutMs,
            idleTimeout: parsed.idleTimeout,
            lifetime: inspected.lifetime,
          });
        }
        const inspectedParams = {
          ...context,
          deadline,
          inspect: inspected,
          resourceReceipt,
          profile: parsed,
          stopLease: stopProvisionLease,
          signal: preparationSignal,
          assertCurrent,
        };
        if (!retention && isNonRunnableState(inspected.state)) {
          return await failProvisionAfterCleanup(
            { ...inspectedParams, id: leaseId },
            new WorkerProviderError(
              `Crabbox warmup lease entered a terminal state${inspected.failureError ? `: ${inspected.failureError}` : ""}`,
            ),
          );
        }
        inspectedParams.inspect = await waitForProvisionReady(inspectedParams);
        inspectedParams.deadline = setupDeadline;
        // The image key covers the exact setup script, so a fork already carries its results.
        if (parsed.setup && allocationChoice.kind !== "checkpoint") {
          await runProvisionSetup({
            ...inspectedParams,
            phase: "profile setup",
            setup: parsed.setup,
          });
          // Setup may restart SSH; refresh its endpoint and security attestation before bootstrap.
          inspectedParams.inspect = await waitForProvisionReady({
            ...inspectedParams,
            refresh: true,
          });
        }
        const desktop = await prepareProvisionDesktop({
          ...inspectedParams,
          wallpaperBase64,
          prepareBeforeEnrollment: Boolean(project),
        });
        if (project?.preparation && (await warmImages.lookupLease(leaseId))?.phase === "enrolled") {
          // An enrolled replay may have lost its response before core registration.
          // Verify the preserved completion only; setup and capture remain closed.
          try {
            await prepareCrabboxProjectFiles({
              ...context,
              id: leaseId,
              project,
              inspectPrepared: true,
              signal: preparationSignal,
              timeoutMs: () => remainingProvisionTimeout(setupDeadline, CRABBOX_SETUP_TIMEOUT_MS),
            });
          } catch (error) {
            preparationSignal?.throwIfAborted();
            return await failProvisionAfterCleanup(
              { ...context, id: leaseId, stopLease: stopProvisionLease },
              error,
            );
          }
        }
        let runtimePrepared = false;
        let runtimeSetupFailed = false;
        const prepareRuntime = async () => {
          const plan = await prepareCrabboxWorkerRuntime({
            context: inspectedParams,
            prepareNodeRuntime: options?.prepareNodeRuntime,
            leaseId,
            preparationSignal,
            assertCurrent,
            onSetupFailure: () => {
              runtimeSetupFailed = true;
            },
          });
          return {
            timeoutMs: plan.timeoutMs,
            run: async (scrubScript?: string) => {
              await plan.run(scrubScript);
              runtimePrepared = true;
              assertCurrent();
            },
          };
        };
        if (project && (await warmImages.lookupLease(leaseId))?.phase !== "enrolled") {
          let captured: boolean | "source-running";
          try {
            const preparedProject = await prepareCrabboxProjectFiles({
              ...context,
              id: leaseId,
              project,
              signal: preparationSignal,
              timeoutMs: () => remainingProvisionTimeout(setupDeadline, CRABBOX_SETUP_TIMEOUT_MS),
              recordRecipePreparation: (metadata) =>
                warmImages.noteRecipePreparation(leaseId, metadata, () => {
                  preparationSignal?.throwIfAborted();
                  assertCurrent();
                }),
              setupSecrets: parsed.setupSecrets,
              assertCurrent,
            });
            assertCurrent();
            await warmImages.markPrepared(
              leaseId,
              project.baseCommit,
              () => {
                preparationSignal?.throwIfAborted();
                assertCurrent();
              },
              preparedProject,
            );
            captured =
              !parsed.warmImage || preparedProject?.captureSkipped
                ? false
                : await warmImages.capture(
                    {
                      ...context,
                      id: leaseId,
                      profile: parsed,
                      cliVersion,
                      signal: preparationSignal,
                      assertCurrent,
                      projectCaptureRequired:
                        preparedProject?.captureRequired || preparedReplay ? true : undefined,
                      projectCaptureReplay: preparedReplay ? true : undefined,
                      ...(allocationChoice.kind === "checkpoint"
                        ? { forkedCheckpointId: allocationChoice.checkpointId }
                        : {}),
                    },
                    prepareRuntime,
                  );
          } catch (error) {
            // The runtime grant has a separate abort signal; revalidate the project owner.
            signal?.throwIfAborted();
            assertCurrent();
            if (runtimeSetupFailed) {
              throw error;
            }
            return await failProvisionAfterCleanup(
              { ...context, id: leaseId, stopLease: stopProvisionLease },
              error,
            );
          }
          // Only native capture can have restarted the source since preparation returned.
          if (captured === true) {
            inspectedParams.inspect = await waitForProvisionReady({
              ...inspectedParams,
              refresh: true,
            });
          }
        }
        signal?.throwIfAborted();
        const beginNodeEnrollment = options?.beginNodeEnrollment;
        if (!beginNodeEnrollment) {
          return await failProvisionAfterCleanup(
            { ...inspectedParams, id: leaseId },
            new Error("Crabbox worker node enrollment is unavailable"),
          );
        }
        let enrollment: CrabboxWorkerNodeEnrollment;
        try {
          // A fork of an image captured for this exact runtime already holds it. Enrollment still
          // verifies the runtime, and the node fetches a missing worker bundle from the Gateway.
          const forkHasRuntime =
            allocationChoice.kind === "checkpoint" &&
            isDeepStrictEqual(
              await warmImages.checkpointRuntimeIdentity(allocationChoice.checkpointId),
              nodeRuntimeIdentity,
            );
          if (
            options?.prepareNodeRuntime &&
            !runtimePrepared &&
            priorAllocation?.phase !== "enrolled" &&
            !forkHasRuntime &&
            (!project || allocationChoice.kind === "checkpoint")
          ) {
            await (await prepareRuntime()).run();
          }
          enrollment = await beginNodeEnrollment();
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
        await runProvisionSetup({
          ...inspectedParams,
          phase: "node enrollment setup",
          signal: enrollmentSignal,
          setup: nodeEnrollmentSetup.command,
          // Combine the existing phase budgets; desktop work starts after node launch.
          timeoutMs:
            resolveCrabboxNodeEnrollmentTimeoutMs(enrollment.bootstrapTimeoutMs) +
            (desktop && !project ? CRABBOX_SETUP_TIMEOUT_MS : 0),
          forwardedEnv: nodeEnrollmentSetup.forwardedEnv,
        });
        let deviceId: string;
        try {
          deviceId = await enrollment.waitForDeviceId();
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
        provisioned = true;
        return {
          ...allocation,
          ...(resourceReceipt ? { resourceReceipt } : {}),
          node: { deviceId },
          ...(desktop ? { desktop: desktop.endpoint } : {}),
        };
      } finally {
        // Failed/cancelled preparation may retain a recoverable allocation, but
        // its abandoned caller no longer owns background idle renewal.
        if (!provisioned) {
          await heartbeats.stop(leaseId);
        }
      }
    };
    return async () => {
      // An admitted dispatch may not have created its lease yet; absence cannot release its hold.
      const owner = { leaseId };
      activeProvisions.add(owner);
      try {
        return await provision();
      } finally {
        activeProvisions.delete(owner);
      }
    };
  };

  return {
    id: CRABBOX_WORKER_PROVIDER_ID,
    supportsResourceReceipts: true,
    resolveDisplayId: (profile) => parseCrabboxProfile(profile).provider,
    // Disposable worker desktops may resize only when the RFB server negotiates support.
    allowsDesktopResize: true,
    async dispose() {
      providerAbort.abort();
      await Promise.all([
        heartbeats.dispose(),
        maintenanceInFlight?.catch(() => {}),
        snapshots.settle(),
        binaryResolver.settle(),
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
    supportsCleanupAcceptance: true,
    provisionBeforeInstallation: true,
    requiresNodeEnrollment: true,
    supportsProjectPreparation: supportsCrabboxProjectPreparation,
    resolvePreparedIdleTimeoutMs: resolveCrabboxPreparedIdleTimeoutMs,
    resolvePreparationTarget: resolveCrabboxPreparationTarget,
    runSetupCommand: createCrabboxSetupCommandRunner({
      resolveBinary: async (...args) => (await resolveBinary(...args)).binary,
    }),
    notePreparedDemand: async (lease, preparation) =>
      await warmImages.notePreparedDemand(lease.leaseId, preparation),
    resolveAllocation,
    resolveProvisionTimeoutMs(profile, options) {
      return resolveCrabboxProvisionCallTimeoutMs(
        parseCrabboxProfile(profile),
        options?.nodeBootstrapTimeoutMs,
      );
    },
    resolveDestroyTimeoutMs(profile) {
      return resolveCrabboxDestroyTimeoutMs(parseCrabboxCleanupProfile(profile));
    },
    prepareProvision,
    async provision(...args) {
      return await (
        await prepareProvision(...args)
      )();
    },
    inspect: leaseLifecycle.inspect,
    setRetainedState: leaseLifecycle.setRetainedState,
    destroy,
  };
}
