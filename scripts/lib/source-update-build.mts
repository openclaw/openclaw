// One output transaction for current source-server scripts and their published first hop.
import fs from "node:fs";
import path from "node:path";
import type { PreManagedServiceStop } from "../../src/cli/update-cli/update-command-service-context-types.js";
import { hasCommandProcessCleanupError } from "../../src/process/exec-result.js";
import { listTsdownOutputRoots } from "../tsdown-build.mts";
import { withDistArtifactOwnership } from "./dist-artifact-ownership.mts";
import { gatewayServiceCommandOverlapsPhysicalCheckout } from "./live-gateway-dist-fence.mts";
import { hasUnjoinedWork, runManagedCommand } from "./managed-child-process.mts";
import { assertRealOutputRoot } from "./output-root-guard.mjs";

type SourceUpdateBuildResult = { exitCode: number; admissionRefused?: true };

const log = (message: string) => console.error(`[update-gateway] ${message}`);

function preserveNativeCleanupFailure(error: unknown): unknown {
  return hasCommandProcessCleanupError(error)
    ? Object.assign(new Error("Native source-update cleanup is unverified.", { cause: error }), {
        processTreeState: "indeterminate",
      })
    : error;
}

type BuildLifecycle = {
  stop: () => Promise<number>;
  restart: () => Promise<number>;
  beginMutation?: () => void;
  settle?: (restartSafe: boolean) => Promise<void>;
  successRestartOwner: "adapter" | "caller";
};

/** Published 9.4 shells build first and own their successful restart afterward. */
export async function runLegacySourceUpdateBuild(
  profile: string,
  build: (env: NodeJS.ProcessEnv) => Promise<SourceUpdateBuildResult>,
): Promise<number | undefined> {
  const env = { ...process.env };
  const restartCommand = env.OPENCLAW_UPDATE_RESTART_CMD ?? "openclaw gateway restart";
  if (profile !== "full" || env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" || !restartCommand.trim()) {
    return undefined;
  }
  const root = fs.realpathSync(process.cwd());
  const {
    readManagedGatewayServiceForUpdate,
    observedSystemdManagerUid,
    assertGatewayServiceAdmissionUnchanged,
    GatewayServiceUpdateOwnershipError,
  } = await import("../../src/cli/update-cli/update-command-service-plan.js");
  const selected = await readManagedGatewayServiceForUpdate(env, root, false).catch(
    (error: unknown) => {
      if (
        !hasCommandProcessCleanupError(error) &&
        error instanceof GatewayServiceUpdateOwnershipError
      ) {
        return null;
      }
      throw preserveNativeCleanupFailure(error);
    },
  );
  if (
    !selected?.running ||
    (await gatewayServiceCommandOverlapsPhysicalCheckout(root, selected.command)) !== true
  ) {
    return undefined;
  }
  const {
    maybeStopManagedServiceBeforeMutableUpdate,
    maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
    createWindowsTaskAutoStartGuard,
  } = await import("../../src/cli/update-cli/update-command-service-maintenance.js");
  const { revalidateManagedGatewayServiceAfterUpdate } =
    await import("../../src/cli/update-cli/update-command-service-revalidation.js");
  const { readGatewayServiceState, resolveGatewayService } =
    await import("../../src/daemon/service.js");
  const { findServiceOwnershipRefusal } =
    await import("../../src/daemon/service-inspection-error.js");
  const { ScheduledTaskAutoStartRecoveryError } =
    await import("../../src/daemon/schtasks-update-recovery.js");
  const expectedService = {
    serviceEnv: selected.env,
    serviceUpdateVerdict: selected.verdict,
    serviceManagerUid: observedSystemdManagerUid(selected),
  };
  let stopped: PreManagedServiceStop | undefined;
  const assertRecoveryCurrent = () =>
    stopped?.windowsTaskAutoStartRecovery?.assertRecoveryCurrent();
  const assertUninterrupted = () => {
    if (stopped?.windowsTaskAutoStartRecovery?.interrupted()) {
      throw new Error("Source update interrupted; successful restart remains unconfirmed.");
    }
  };
  const revalidate = async () => {
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: selected.env,
      requireEffective: true,
      requireLoadedCommand: true,
    });
    const verdict = await revalidateManagedGatewayServiceAfterUpdate({
      state,
      root,
      preManagedServiceStop: stopped ?? expectedService,
      allowInstallRootChange: false,
    });
    if (verdict.kind !== "owned") {
      throw new Error("The original selected Gateway no longer owns this source checkout.");
    }
    // Builds never rewrite the service definition; refresh permission is not drift permission.
    assertGatewayServiceAdmissionUnchanged(expectedService, verdict);
  };
  const restoreAutoStart = async () => {
    const before = stopped;
    if (before) {
      await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(before, true, async () => {
        assertRecoveryCurrent();
        await createWindowsTaskAutoStartGuard({ root, before })();
        assertRecoveryCurrent();
        await revalidate();
        assertRecoveryCurrent();
      });
    }
  };
  return await runSourceUpdateBuild({
    root,
    // The old shell already prepared its pnpm launcher and workspace environment.
    build: () => build(env),
    lifecycle: {
      successRestartOwner: "caller",
      stop: async () => {
        let partialStop: PreManagedServiceStop | undefined;
        try {
          stopped = await maybeStopManagedServiceBeforeMutableUpdate({
            updateInstallKind: "git",
            root,
            shouldRestart: true,
            jsonMode: false,
            phase: "prepare",
            expectedService,
            allowInstallRootChange: false,
            onStopped: (observation) => {
              partialStop = observation;
            },
          });
        } catch (error) {
          // The maintenance owner settles its suspension before rejecting. Its
          // mutation observation carries no open recovery token to complete twice.
          stopped = partialStop;
          if (
            partialStop &&
            !hasUnjoinedWork(error) &&
            !hasCommandProcessCleanupError(error) &&
            !findServiceOwnershipRefusal(error) &&
            !(error instanceof ScheduledTaskAutoStartRecoveryError)
          ) {
            try {
              // Reacquire native custody and recheck the original binding inside it.
              const restarted = await resolveGatewayService().restart({
                env: selected.env,
                stdout: process.stdout,
                preserveDefinition: true,
                beforeMutation: revalidate,
              });
              if (restarted.outcome !== "completed") {
                throw new Error("Original Gateway restart was not completed after partial stop.", {
                  cause: error,
                });
              }
            } catch (recoveryError) {
              throw new AggregateError(
                [error, recoveryError],
                "Source update stop and original-runtime recovery failed.",
                { cause: recoveryError },
              );
            }
          }
          throw error;
        }
        if (!stopped.stopped || stopped.blockMessage || stopped.serviceMutationAllowed === false) {
          throw new Error(
            stopped.blockMessage ??
              stopped.serviceMutationSkipMessage ??
              "The selected Gateway was not stopped.",
          );
        }
        return 0;
      },
      beginMutation: () => stopped?.windowsTaskAutoStartRecovery?.beginMutation(),
      restart: async () => {
        assertRecoveryCurrent();
        await revalidate();
        assertRecoveryCurrent();
        await restoreAutoStart();
        assertRecoveryCurrent();
        return await runManagedCommand({
          bin: "bash",
          args: ["-c", restartCommand],
          cwd: root,
          env,
          stdio: "inherit",
          assertCurrent: assertRecoveryCurrent,
        });
      },
      settle: async (restartSafe) => {
        if (!stopped) {
          return;
        }
        const recovery = stopped?.windowsTaskAutoStartRecovery;
        let restored = false;
        const errors: unknown[] = [];
        try {
          if (restartSafe) {
            await revalidate();
            await restoreAutoStart();
            restored = true;
          }
        } catch (error) {
          errors.push(error);
        }
        try {
          await recovery?.complete(restartSafe && restored);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) {
          throw new AggregateError(errors, "Source-update native recovery did not settle.");
        }
        if (restartSafe) {
          assertUninterrupted();
        }
      },
    },
  });
}

export async function runSourceUpdateBuild({
  root,
  build,
  lifecycle,
}: {
  root: string;
  build: () => Promise<SourceUpdateBuildResult>;
  lifecycle: BuildLifecycle;
}): Promise<number> {
  return await withDistArtifactOwnership(root, async () => {
    let restartSafe = true;
    let settlementAttempted = false;
    const settle = async () => {
      settlementAttempted = true;
      await lifecycle.settle?.(restartSafe);
    };
    const [outcome] = await Promise.allSettled([
      (async () => {
        const roots = listTsdownOutputRoots();
        // Validate parents as well as final components before any service effects.
        // This is the same no-symlink contract as the build cleanup owner.
        for (const output of roots) {
          let current = root;
          for (const component of output.split("/")) {
            current = path.join(current, component);
            assertRealOutputRoot(current);
          }
        }
        log("stopping gateway before replacing hashed build chunks");
        const stopped = await lifecycle.stop();
        if (stopped !== 0) {
          return stopped;
        }
        try {
          lifecycle.beginMutation?.();
        } catch (error) {
          // Nothing has changed on disk, but the old caller will exit on this failure.
          try {
            const restarted = await lifecycle.restart();
            if (restarted !== 0) {
              throw new Error(`Original Gateway restart failed (${restarted}) before build.`, {
                cause: error,
              });
            }
          } catch (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              "Source build admission and original-runtime recovery failed.",
              { cause: recoveryError },
            );
          }
          throw error;
        }
        restartSafe = false;

        let backup: string | undefined;
        let buildStarted = false;
        let admissionRefused = false;
        let failed: { error: unknown } | undefined;
        let exitCode = 1;
        try {
          backup = fs.mkdtempSync(path.join(root, ".update-build-backup."));
          for (const output of roots) {
            const source = path.join(root, output);
            if (fs.existsSync(source)) {
              const destination = path.join(backup, output);
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              // Copy rather than move: the build deliberately preserves UI assets,
              // signed app bundles and some declarations inside its output roots.
              fs.cpSync(source, destination, {
                recursive: true,
                dereference: false,
                verbatimSymlinks: true,
                preserveTimestamps: true,
              });
            }
          }
          buildStarted = true;
          const result = await build();
          exitCode = result.exitCode;
          admissionRefused = result.admissionRefused === true;
        } catch (error) {
          failed = { error };
        }

        if (exitCode !== 0 || failed) {
          if (hasUnjoinedWork(failed?.error)) {
            throw new Error(
              `Build writers have not settled; previous output retained at ${backup}`,
              {
                cause: failed?.error,
              },
            );
          }
          try {
            if (buildStarted && backup && !admissionRefused) {
              log("restoring previous build output");
              try {
                // Validate the whole replacement set before restoring any root.
                for (const output of roots) {
                  // Build children have joined; do not follow a replaced root/parent.
                  let current = root;
                  for (const component of output.split("/")) {
                    current = path.join(current, component);
                    assertRealOutputRoot(current);
                  }
                }
                for (const output of roots) {
                  const destination = path.join(root, output);
                  fs.rmSync(destination, { recursive: true, force: true });
                  const previous = path.join(backup, output);
                  if (fs.existsSync(previous)) {
                    fs.mkdirSync(path.dirname(destination), { recursive: true });
                    fs.renameSync(previous, destination);
                  }
                }
              } catch (error) {
                throw new Error(`Previous output could not be fully restored; retained ${backup}`, {
                  cause: error,
                });
              }
            }
            log("restarting gateway on previous build after update failure");
            const restarted = await lifecycle.restart();
            if (restarted !== 0) {
              throw new Error(
                `Previous build restored, but restart failed (${restarted}); backup: ${backup}`,
              );
            }
            restartSafe = true;
            await settle();
            if (backup) {
              fs.rmSync(backup, { recursive: true, force: true });
            }
          } catch (recoveryError) {
            throw new AggregateError(
              [
                failed ? failed.error : new Error(`Source build failed (exit ${exitCode}).`),
                recoveryError,
              ],
              `Source build recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
              { cause: recoveryError },
            );
          }
          if (failed) {
            throw failed.error instanceof Error
              ? failed.error
              : new Error("Build failed", { cause: failed.error });
          }
          return exitCode;
        }

        if (lifecycle.successRestartOwner === "caller") {
          restartSafe = true;
          // The old shell cannot adopt this process's native recovery receipt.
          // Settle it before returning, but leave the successful restart to that shell.
          await settle();
          fs.rmSync(backup!, { recursive: true, force: true });
          return 0;
        }
        log("restarting gateway");
        const restarted = await lifecycle.restart();
        if (restarted !== 0) {
          // A failed restart can still leave a new Gateway running. Do not replace
          // its chunks underneath it; keep the previous output for operator recovery.
          throw new Error(
            `New build restart failed (${restarted}); previous output retained at ${backup}`,
          );
        }
        restartSafe = true;
        await settle();
        fs.rmSync(backup!, { recursive: true, force: true });
        return 0;
      })(),
    ]);
    const failure =
      outcome.status === "rejected"
        ? { error: preserveNativeCleanupFailure(outcome.reason) }
        : undefined;
    if (failure && hasUnjoinedWork(failure.error)) {
      restartSafe = false;
    }
    try {
      if (!settlementAttempted) {
        await settle();
      }
    } catch (cause) {
      const error = preserveNativeCleanupFailure(cause);
      throw failure
        ? new AggregateError([failure.error, error], "Source build and native settlement failed", {
            cause,
          })
        : error;
    }
    if (outcome.status === "rejected") {
      throw failure!.error;
    }
    return outcome.value;
  });
}
