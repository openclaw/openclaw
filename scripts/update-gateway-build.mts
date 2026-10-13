// Source-update lifecycle adapter. Both entry paths share the output transaction.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertManagedGatewayArtifactPublication } from "../src/cli/update-cli/update-command-service-revalidation.js";
import { resolvePathViaExistingAncestorSync } from "../src/infra/boundary-path.js";
import { sha256File } from "../src/infra/crypto-digest.js";
import { hasErrnoCode } from "../src/infra/errno.js";
import { isPathInside } from "../src/infra/path-guards.js";
import {
  readBuiltRuntimeCommit,
  verifyGitUpdateRecovery,
} from "../src/infra/update-git-runtime.js";
import { runGitCandidatePreflight } from "../src/infra/update-runner-git-preflight.js";
import {
  createGitRuntimeTransaction,
  prepareGitRuntimePromotion,
} from "../src/infra/update-runner-git-runtime.js";
import { withGitTargetInspectionRoot } from "../src/infra/update-runner-git-target.js";
import { prepareGitCandidateTransfer } from "../src/infra/update-runner-git-transfer.js";
import type { CommandRunner, RunStepOptions } from "../src/infra/update-runner-types.js";
import { isGitRuntimeStagingName } from "../src/infra/update-runtime-staging.js";
import type { UpdateStepResult } from "../src/infra/update-step-result.js";
import { hasCommandProcessCleanupError } from "../src/process/exec-result.js";
import { withCommandProcessScope } from "../src/process/exec-spawn.js";
import { runCommandWithTimeout } from "../src/process/exec.js";
import { runBuildAllSteps } from "./build-all.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { inspectOwnedSourceUpdateArtifacts } from "./lib/source-update-artifact-preflight.mts";
import { preserveNativeCleanupFailure, runSourceUpdateBuild } from "./lib/source-update-build.mts";

const PROBE_TIMEOUT_MS = 120_000;

// The script deliberately accepts local build inputs. Runtime outputs and caches
// remain with their existing owners rather than becoming candidate source inputs.
const sourceInputExclusions = [".artifacts", "node_modules", "dist", "dist-runtime"];

async function captureReferenceInputs(root: string, git: (args: string[]) => Promise<string>) {
  const inspectExternalTarget = async (
    target: string,
    physicalTarget = resolvePathViaExistingAncestorSync(target),
  ) => {
    const payload = await fs.promises
      .stat(physicalTarget, { bigint: true })
      .catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
          return undefined;
        }
        throw error;
      });
    return {
      kind: "external" as const,
      path: target,
      // Directories remain operator-owned references, not recursive content snapshots.
      payload: payload
        ? {
            path: physicalTarget,
            kind: payload.isFile() ? "file" : payload.isDirectory() ? "directory" : "other",
            identity: `${payload.dev}:${payload.ino}`,
            mode: Number(payload.mode),
            size: payload.size,
            modifiedAtNs: payload.mtimeNs,
            changedAtNs: payload.ctimeNs,
            digest: payload.isFile() ? await sha256File(physicalTarget) : null,
          }
        : { path: physicalTarget, kind: "missing" },
    };
  };
  const inspectLinkTarget = async (file: string, link: string) => {
    const target = path.resolve(path.dirname(file), link);
    // Source-owned intermediate links must follow the candidate's Git revision.
    if (isPathInside(root, target)) {
      return { kind: "candidate" as const, relative: path.relative(root, target) };
    }
    const physicalTarget = resolvePathViaExistingAncestorSync(target);
    if (isPathInside(root, physicalTarget)) {
      return { kind: "candidate" as const, relative: path.relative(root, physicalTarget) };
    }
    return inspectExternalTarget(target, physicalTarget);
  };
  // Retain the first external reference, so later checks survive candidate cleanup
  // and still observe external link reroutes through the canonical resolver.
  const externalCandidateReference = async (candidate: string, target: string) => {
    let reference = target;
    const seen = new Set<string>();
    while (isPathInside(candidate, reference)) {
      if (seen.has(reference)) {
        throw new Error(`Cannot observe candidate build input: ${target}`);
      }
      seen.add(reference);
      const parts = path.relative(candidate, reference).split(path.sep);
      let prefix = candidate;
      let next: string | undefined;
      for (let index = 0; index < parts.length; index++) {
        prefix = path.join(prefix, parts[index]!);
        if ((await fs.promises.lstat(prefix)).isSymbolicLink()) {
          next = path.resolve(
            path.dirname(prefix),
            await fs.promises.readlink(prefix),
            ...parts.slice(index + 1),
          );
          break;
        }
      }
      if (!next) {
        throw new Error(`Cannot observe candidate build input: ${target}`);
      }
      reference = next;
    }
    if (
      resolvePathViaExistingAncestorSync(reference) !== resolvePathViaExistingAncestorSync(target)
    ) {
      throw new Error(`Cannot verify candidate build input reference: ${target}`);
    }
    return reference;
  };
  const candidateExternal: Awaited<ReturnType<typeof inspectExternalTarget>>[] = [];
  const snapshot = async (stagingPaths: readonly string[] = []) => {
    const names = (
      await git([
        "ls-files",
        "--others",
        "-z",
        "--",
        ".",
        ...sourceInputExclusions.flatMap((name) => [
          `:(exclude)${name}`,
          `:(exclude)**/${name}/**`,
        ]),
        ...stagingPaths.map((name) => `:(top,exclude,literal)${name}`),
      ])
    )
      .split("\0")
      .filter((name) => name && !name.split("/").some(isGitRuntimeStagingName))
      .toSorted();
    return await Promise.all(
      names.map(async (name) => {
        const file = path.join(root, name);
        const stat = await fs.promises.lstat(file, { bigint: true });
        if (!stat.isFile() && !stat.isSymbolicLink()) {
          throw new Error(`Unsupported untracked source input: ${name}`);
        }
        const link = stat.isSymbolicLink() ? await fs.promises.readlink(file) : null;
        return {
          name,
          identity: `${stat.dev}:${stat.ino}`,
          mode: Number(stat.mode),
          link,
          target: link === null ? null : await inspectLinkTarget(file, link),
          digest: stat.isFile() ? await sha256File(file) : null,
        };
      }),
    );
  };
  const original = await snapshot();
  return {
    async assertUnchanged(stagingPaths: readonly string[] = []) {
      const external = await Promise.all(
        candidateExternal.map(({ path: target }) => inspectExternalTarget(target)),
      );
      if (
        !isDeepStrictEqual(await snapshot(stagingPaths), original) ||
        !isDeepStrictEqual(external, candidateExternal)
      ) {
        throw new Error("Local source build inputs changed while preparing the update.");
      }
    },
    async copy(candidate: string) {
      for (const entry of original) {
        const destination = path.join(candidate, entry.name);
        let parent = candidate;
        for (const component of entry.name.split("/").slice(0, -1)) {
          parent = path.join(parent, component);
          const stat = await fs.promises.lstat(parent).catch((error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return undefined;
            }
            throw error;
          });
          if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
            throw new Error(`Candidate source input parent is not a real directory: ${entry.name}`);
          }
          if (!stat) {
            await fs.promises.mkdir(parent);
          }
        }
        if (entry.target !== null) {
          const copiedTarget =
            entry.target.kind === "candidate"
              ? path.join(candidate, entry.target.relative)
              : entry.target.path;
          await fs.promises.symlink(copiedTarget, destination);
        } else {
          await fs.promises.copyFile(
            path.join(root, entry.name),
            destination,
            fs.constants.COPYFILE_EXCL,
          );
          await fs.promises.chmod(destination, entry.mode);
          if ((await sha256File(destination)) !== entry.digest) {
            throw new Error(`Local source input changed during copying: ${entry.name}`);
          }
        }
      }
      candidateExternal.length = 0;
      for (const entry of original) {
        if (entry.target?.kind !== "candidate") {
          continue;
        }
        const target = path.join(candidate, entry.target.relative);
        const physical = resolvePathViaExistingAncestorSync(target);
        if (isPathInside(candidate, physical) || isPathInside(root, physical)) {
          continue;
        }
        const reference = await externalCandidateReference(candidate, target);
        candidateExternal.push(await inspectExternalTarget(reference, physical));
      }
      await this.assertUnchanged();
    },
  };
}

async function runReferenceSourceUpdate(
  root: string,
  stopCommand: string,
  restartCommand: string,
  pnpmDirectory: string,
  targetSha: string,
): Promise<number> {
  if (!/^[0-9a-f]{40}$/u.test(targetSha)) {
    throw new Error("Source update requires the pinned fetched commit.");
  }
  return await withDistArtifactOwnership(root, () =>
    withCommandProcessScope(async () => {
      const rootIdentity = fs.statSync(root, { bigint: true });
      let uncertainCommand: { error: unknown } | undefined;
      const assertCurrent = () => {
        if (uncertainCommand) {
          throw uncertainCommand.error;
        }
        const current = fs.statSync(root, { bigint: true });
        if (current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) {
          throw new Error("Source checkout identity changed during update.");
        }
      };
      const assertRuntimeDestination = (destination: string) => {
        assertCurrent();
        if (!isPathInside(root, destination) || destination === root) {
          throw new Error("Source runtime destination escapes the serving checkout.");
        }
        let current = root;
        for (const component of path.relative(root, destination).split(path.sep)) {
          current = path.join(current, component);
          assertRealOutputRoot(current);
        }
      };
      const env = {
        ...process.env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        PATH: `${pnpmDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        npm_execpath: path.join(pnpmDirectory, "pnpm"),
      };
      const runCommand: CommandRunner = async (argv, options) => {
        if (uncertainCommand) {
          throw uncertainCommand.error;
        }
        assertCurrent();
        const result = await withCommandProcessScope(() =>
          runCommandWithTimeout(argv, {
            ...options,
            env: {
              ...env,
              ...options.env,
              GIT_OPTIONAL_LOCKS: "0",
              NPM_CONFIG_WORKSPACE_DIR: options.cwd ?? root,
              npm_config_workspace_dir: options.cwd ?? root,
              PNPM_CONFIG_LOCKFILE_DIR: options.cwd ?? root,
              pnpm_config_lockfile_dir: options.cwd ?? root,
            },
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          }),
        ).catch((error: unknown) => {
          if (hasCommandProcessCleanupError(error)) {
            uncertainCommand = { error };
          }
          throw error;
        });
        assertCurrent();
        return result;
      };
      const git = async (args: string[]) => {
        const result = await runCommand(["git", "-C", root, ...args], {
          cwd: root,
          timeoutMs: PROBE_TIMEOUT_MS,
          terminateOnOutputLimit: true,
        });
        if (result.code !== 0 || result.signal || result.killed || result.outputLimitExceeded) {
          throw new Error(`Source update Git ${args[0]} failed (exit ${result.code}).`);
        }
        return result.stdout;
      };
      const beforeSha = (await git(["rev-parse", "HEAD"])).trim();
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      const beforeBuiltCommit = await readBuiltRuntimeCommit(root);
      const sourceRuntimePrepared = await inspectOwnedSourceUpdateArtifacts(root, assertCurrent);
      const inputs = await captureReferenceInputs(root, git);
      let promotion: Awaited<ReturnType<typeof prepareGitRuntimePromotion>> | undefined;
      let transfer:
        | Extract<Awaited<ReturnType<typeof prepareGitCandidateTransfer>>, { status: "ok" }>
        | undefined;
      let candidateSha = beforeSha;
      let expectedSha = beforeSha;
      let sourceChanged = false;
      let stopped = false;
      let preserve = false;
      let transactionRetained = false;
      const steps: UpdateStepResult[] = [];
      const step = (
        name: string,
        argv: string[],
        cwd: string,
        commandEnv?: NodeJS.ProcessEnv,
      ): RunStepOptions => ({
        name,
        argv,
        cwd,
        env: commandEnv,
        runCommand,
        timeoutMs: PROBE_TIMEOUT_MS,
        stepIndex: 0,
        totalSteps: 0,
        results: steps,
        progress: {
          onStepStart: ({ name: stepName }) => console.error(`[update-gateway] ${stepName}`),
          onStepComplete: ({ exitCode, failureFacts, advisory }) => {
            if (advisory?.message) {
              console.error(`[update-gateway] ${advisory.message}`);
            }
            if (exitCode !== 0) {
              for (const fact of failureFacts ?? []) {
                if (fact.message && fact.message !== advisory?.message) {
                  console.error(`[update-gateway] ${fact.message}`);
                }
              }
            }
          },
        },
      });
      const assertSourceCurrent = async () => {
        assertCurrent();
        if (
          (await git(["rev-parse", "HEAD"])).trim() !== expectedSha ||
          (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim() !== branch
        ) {
          throw new Error("Source checkout or branch changed during update.");
        }
        await git(["diff", "--quiet"]);
        await git(["diff", "--cached", "--quiet"]);
        await inputs.assertUnchanged(promotion?.sourceTreeStagingPaths);
        assertCurrent();
      };
      const lifecycle = (command: string) =>
        runManagedCommand({
          bin: "bash",
          args: ["-c", command],
          cwd: root,
          stdio: "inherit",
          env,
        });
      const [outcome] = await Promise.allSettled([
        (async () => {
          try {
            await assertSourceCurrent();
            const prepared = await withGitTargetInspectionRoot(
              {
                root,
                runCommand,
                timeoutMs: PROBE_TIMEOUT_MS,
                onWarning: (warning) =>
                  console.error(`[update-gateway] ${warning.stderrTail ?? warning.name}`),
              },
              async (inspectionRoot, inspectCommand) => {
                const inspectionStep = (
                  name: string,
                  argv: string[],
                  cwd: string,
                  commandEnv?: NodeJS.ProcessEnv,
                ) => ({
                  ...step(name, argv, cwd, commandEnv),
                  runCommand: inspectCommand,
                });
                const result = await runGitCandidatePreflight({
                  gitRoot: inspectionRoot,
                  artifactRoot: root,
                  refreshedRemotes: [],
                  targetRevision: targetSha,
                  beforeSha,
                  beforeRuntimeVerified: false,
                  sourceRuntimePrepared,
                  needsCheckoutMain: false,
                  runCommand: inspectCommand,
                  timeoutMs: PROBE_TIMEOUT_MS,
                  defaultCommandEnv: env,
                  steps,
                  step: inspectionStep,
                  workStep: (...args) => ({ ...inspectionStep(...args), timeoutMs: undefined }),
                  beforeCandidate: async () => assertSourceCurrent(),
                  validateCandidate: async (candidate) => {
                    const head = await inspectCommand(
                      ["git", "-C", candidate, "rev-parse", "HEAD"],
                      {
                        cwd: candidate,
                        timeoutMs: PROBE_TIMEOUT_MS,
                        terminateOnOutputLimit: true,
                      },
                    );
                    if (
                      head.code !== 0 ||
                      !(
                        await verifyGitUpdateRecovery({
                          root: candidate,
                          sha: head.stdout.trim(),
                        })
                      ).serviceRestartSafe
                    ) {
                      throw new Error(
                        "Prepared source runtime could not be verified; the serving checkout is unchanged.",
                      );
                    }
                  },
                  referenceSource: {
                    branch,
                    copyBuildInputs: (candidate) => inputs.copy(candidate),
                  },
                  prepareCandidate: async (candidate, cleanupRoot) => {
                    promotion = await prepareGitRuntimePromotion(
                      root,
                      candidate,
                      inspectCommand,
                      PROBE_TIMEOUT_MS,
                      cleanupRoot,
                      assertRuntimeDestination,
                    );
                  },
                });
                if (result.status === "ok") {
                  candidateSha = result.candidateSha;
                  const preparedTransfer = await prepareGitCandidateTransfer({
                    candidateSha,
                    beforeSha,
                    installedRoot: root,
                    installedRunCommand: runCommand,
                    step: {
                      ...inspectionStep("source-update-pack", [], inspectionRoot),
                      timeoutMs: undefined,
                    },
                    probeTimeoutMs: PROBE_TIMEOUT_MS,
                  });
                  if (preparedTransfer?.status === "ok") {
                    transfer = preparedTransfer;
                  }
                }
                return result;
              },
            );
            if (prepared.status !== "ok" || !promotion || !transfer) {
              throw new Error(
                `Source candidate preparation failed: ${prepared.status === "ok" ? "candidate transfer unavailable" : prepared.reason}`,
              );
            }
            await assertSourceCurrent();
            const stopCode = await lifecycle(stopCommand);
            if (stopCode !== 0) {
              return stopCode;
            }
            stopped = true;
            const transaction = createGitRuntimeTransaction({
              root,
              promotion,
              assertRollbackSafe: assertSourceCurrent,
              restoreRuntime: async (guard) => {
                guard();
                // Git reconstructs tracked output bytes after the retained directories return.
                await promotion!.restore(guard);
                if (sourceChanged) {
                  await assertSourceCurrent();
                  // Directory replacement invalidates the index stat cache used by --keep.
                  await git(["update-index", "--refresh"]);
                  await assertSourceCurrent();
                  await git(["reset", "--keep", beforeSha]);
                  expectedSha = beforeSha;
                }
                await assertSourceCurrent();
                const verified = (
                  await verifyGitUpdateRecovery({ root, sha: beforeBuiltCommit ?? beforeSha })
                ).serviceRestartSafe;
                return {
                  name: "git-runtime-rollback",
                  command: "restore previous Git runtime",
                  cwd: root,
                  durationMs: 0,
                  exitCode: verified ? 0 : 1,
                  activePackageRoot: root,
                };
              },
            });
            transactionRetained = true;
            try {
              await assertSourceCurrent();
              if (
                !(await transfer.importInto({
                  ...step("source-update-import", [], root),
                  timeoutMs: undefined,
                }))
              ) {
                throw new Error("Prepared source objects could not be imported.");
              }
              await assertSourceCurrent();
              // Import can outlive the earlier service state. Observe at publication admission.
              await withCommandProcessScope(() =>
                assertManagedGatewayArtifactPublication({
                  roots: [root],
                  env,
                  timeoutMs: PROBE_TIMEOUT_MS,
                  assertCurrent,
                  updateInstallKind: "git",
                  shouldRestart: true,
                }),
              );
              sourceChanged = true;
              try {
                await git(["reset", "--keep", candidateSha]);
                expectedSha = candidateSha;
              } catch (error) {
                // A joined Git refusal can leave the original source untouched.
                // A partial or unrelated replacement must not authorize a restart.
                try {
                  const actualHead = (await git(["rev-parse", "HEAD"])).trim();
                  if (actualHead === beforeSha) {
                    expectedSha = beforeSha;
                    await assertSourceCurrent();
                    sourceChanged = false;
                  } else if (actualHead === candidateSha) {
                    expectedSha = candidateSha;
                  }
                } catch (reconciliationError) {
                  throw new AggregateError(
                    [error, reconciliationError],
                    "Source checkout reset and reconciliation failed.",
                    { cause: reconciliationError },
                  );
                }
                throw error;
              }
              await promotion.activate();
              await assertSourceCurrent();
              const verification = await verifyGitUpdateRecovery({ root, sha: candidateSha });
              if (!verification.serviceRestartSafe) {
                throw new Error("Published source runtime could not be verified.");
              }
            } catch (error) {
              if (hasUnjoinedWork(error) || hasCommandProcessCleanupError(error)) {
                preserve = true;
                throw error;
              }
              try {
                const restored = await transaction.rollback(assertCurrent);
                if (restored.exitCode !== 0) {
                  throw new Error(
                    `Previous source runtime could not be restored; retained ${promotion.backupRoot}`,
                    { cause: error },
                  );
                }
                const restartCode = await lifecycle(restartCommand);
                if (restartCode !== 0) {
                  throw new Error(
                    `Previous runtime restart failed (${restartCode}); retained ${promotion.backupRoot}`,
                    { cause: error },
                  );
                }
                stopped = false;
                const cleanup = await transaction.complete(
                  { activationVerified: false },
                  assertCurrent,
                );
                if (cleanup) {
                  console.error(`[update-gateway] ${cleanup.stderrTail}`);
                }
              } catch (recoveryError) {
                preserve = true;
                throw new AggregateError(
                  [error, recoveryError],
                  "Source update and original-runtime recovery failed.",
                  { cause: recoveryError },
                );
              }
              throw error;
            }
            // Once restart is attempted a new process may serve the candidate. Keep its
            // artifacts in place on failure; retained originals are for operator recovery.
            preserve = true;
            const restarted = await lifecycle(restartCommand);
            if (restarted !== 0) {
              throw new Error(
                `New runtime restart failed (${restarted}); retained ${promotion.backupRoot}`,
              );
            }
            stopped = false;
            const cleanup = await transaction.complete({ activationVerified: true }, assertCurrent);
            if (cleanup) {
              console.error(`[update-gateway] ${cleanup.stderrTail}`);
            }
            preserve = false;
            return 0;
          } catch (error) {
            preserve ||=
              Boolean(uncertainCommand) ||
              stopped ||
              hasUnjoinedWork(error) ||
              hasCommandProcessCleanupError(error);
            throw error;
          }
        })(),
      ]);
      const cleanupErrors: unknown[] = [];
      if (!preserve) {
        try {
          await transfer?.cleanup(step("source-update-pack-cleanup", [], root));
          assertCurrent();
          if (!transactionRetained) {
            await promotion?.cleanup(assertCurrent);
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      // Closing our pinned descriptor never removes retained recovery files.
      try {
        await transfer?.[Symbol.asyncDispose]();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length) {
        const operationErrors =
          outcome.status === "rejected"
            ? [outcome.reason]
            : outcome.value !== 0
              ? [new Error(`Source update stop failed (exit ${outcome.value}).`)]
              : [];
        throw new AggregateError(
          [...operationErrors, ...cleanupErrors],
          "Source update and preparation cleanup failed.",
          { cause: cleanupErrors.at(-1) },
        );
      }
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
      return outcome.value;
    }).catch((error: unknown) => {
      throw preserveNativeCleanupFailure(error);
    }),
  );
}

export async function runUpdateGatewayBuild(
  stopCommand: string,
  restartCommand: string,
  pnpmDirectory: string,
  targetSha?: string,
): Promise<number> {
  const root = fs.realpathSync(process.cwd());
  if (targetSha !== undefined) {
    return await runReferenceSourceUpdate(
      root,
      stopCommand,
      restartCommand,
      pnpmDirectory,
      targetSha,
    );
  }
  const lifecycle = (command: string) =>
    runManagedCommand({
      bin: "bash",
      args: ["-c", command],
      cwd: root,
      stdio: "inherit",
      // Service commands can intentionally leave a daemon running. Only build
      // writers must join their whole process tree before output restoration.
    });
  const build = () =>
    runBuildAllSteps("full", {
      env: {
        ...process.env,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        PATH: `${pnpmDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        npm_execpath: path.join(pnpmDirectory, "pnpm"),
        NPM_CONFIG_WORKSPACE_DIR: root,
        npm_config_workspace_dir: root,
        PNPM_CONFIG_LOCKFILE_DIR: root,
        pnpm_config_lockfile_dir: root,
      },
    });
  return await runSourceUpdateBuild({
    root,
    build,
    lifecycle: {
      stop: () => lifecycle(stopCommand),
      restart: () => lifecycle(restartCommand),
      successRestartOwner: "adapter",
    },
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const [stopCommand, restartCommand, pnpmDirectory, targetSha] = process.argv.slice(2);
  if (!stopCommand?.trim() || !restartCommand?.trim() || !pnpmDirectory) {
    throw new Error("Source update build requires nonblank stop and restart commands");
  }
  process.exitCode = await runUpdateGatewayBuild(
    stopCommand,
    restartCommand,
    pnpmDirectory,
    targetSha,
  );
}
